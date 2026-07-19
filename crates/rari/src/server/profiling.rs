//! jemalloc-backed production profiling: Prometheus memory metrics + on-demand
//! pprof heap dumps. Compiled only with the `jemalloc` feature (see main.rs, which
//! installs `tikv_jemallocator::Jemalloc` as the global allocator).
//!
//! - `GET /_rari/metrics` — allocator stats in Prometheus text format. Always
//!   available with the feature on; cheap; scrape it continuously.
//! - `GET /_rari/debug/heap` — a symbolized pprof heap profile (protobuf, feeds
//!   Grafana Pyroscope / `go tool pprof`). Requires the process to run with
//!   `MALLOC_CONF=prof:true,prof_active:true` AND a matching `X-Rari-Profiling-Token`
//!   header (value from the `RARI_PROFILING_TOKEN` env). 403 when the env is unset.

use axum::{
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use tikv_jemalloc_ctl::{epoch, stats};

/// Continuously push jemalloc heap profiles to Pyroscope, mirroring what the
/// Go services do with pyroscope-go. Active only when `PYROSCOPE_URL` is set
/// AND the process runs with `MALLOC_CONF=prof:true,prof_active:true`.
/// Profiles land as `<PYROSCOPE_APP_NAME|frontend>` with the profile type
/// derived from the pprof sample types (inuse_space).
pub fn spawn_pyroscope_pusher() {
    let Ok(server) = std::env::var("PYROSCOPE_URL") else {
        return;
    };
    if server.is_empty() {
        return;
    }
    let app = std::env::var("PYROSCOPE_APP_NAME").unwrap_or_else(|_| "frontend".to_string());
    let pod = std::env::var("POD_NAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let node = std::env::var("NODE_NAME").unwrap_or_else(|_| "unknown".to_string());
    // Matches pyroscope-go's UploadRate in the backend.
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

    tokio::spawn(async move {
        let name = format!("{app}{{pod={pod},node={node}}}");
        let client = reqwest::Client::new();
        let mut last_logged_err = false;
        loop {
            tokio::time::sleep(INTERVAL).await;

            let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
                continue;
            };
            let pprof = {
                let mut ctl = prof_ctl.lock().await;
                if !ctl.activated() {
                    continue;
                }
                match ctl.dump_pprof() {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("pyroscope pusher: dump_pprof failed: {e}");
                        continue;
                    }
                }
            };
            // In-process symbolization (pprof_util's `symbolize`) parses the
            // binary's DWARF into the backtrace crate's global cache and would
            // keep tens of MB resident between pushes; re-parsing once a
            // minute is cheaper than holding it.
            backtrace::clear_symbol_cache();

            let until = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let from = until.saturating_sub(INTERVAL.as_secs());

            let Ok(mut url) = url::Url::parse(&format!("{server}/ingest")) else {
                tracing::warn!("pyroscope pusher: invalid PYROSCOPE_URL: {server}");
                return;
            };
            url.query_pairs_mut()
                .append_pair("name", &name)
                .append_pair("from", &from.to_string())
                .append_pair("until", &until.to_string())
                .append_pair("format", "pprof");

            let res = client.post(url).body(pprof).send().await;

            match res {
                Ok(r) if r.status().is_success() => {
                    last_logged_err = false;
                }
                Ok(r) => {
                    if !last_logged_err {
                        tracing::warn!("pyroscope pusher: ingest returned {}", r.status());
                        last_logged_err = true;
                    }
                }
                Err(e) => {
                    // Log once per outage, not every minute.
                    if !last_logged_err {
                        tracing::warn!("pyroscope pusher: ingest failed: {e}");
                        last_logged_err = true;
                    }
                }
            }
        }
    });
}

/// Reverse-connect to the pprof-gateway (same protocol as the Go services'
/// pkg/client): websocket to `$PPROF_GATEWAY_URL/connect`, register with
/// `{service, hostname}`, then answer `{id, url}` profile requests. rari can
/// serve `/debug/pprof/heap` (jemalloc pprof); other profile types get a 404
/// response so the gateway UI degrades gracefully.
pub fn spawn_pprof_gateway_client() {
    let Ok(gateway) = std::env::var("PPROF_GATEWAY_URL") else {
        return;
    };
    if gateway.is_empty() {
        return;
    }

    let mut hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "rari-unknown".to_string());
    if let Ok(node) = std::env::var("NODE_NAME") {
        hostname = format!("{hostname}@{node}");
    }

    tokio::spawn(async move {
        // http(s) -> ws(s)
        let ws_url = if let Some(rest) = gateway.strip_prefix("https://") {
            format!("wss://{rest}/connect")
        } else if let Some(rest) = gateway.strip_prefix("http://") {
            format!("ws://{rest}/connect")
        } else {
            format!("{gateway}/connect")
        };

        loop {
            match run_gateway_session(&ws_url, &hostname).await {
                Ok(()) => tracing::info!("pprof-gateway session closed; reconnecting"),
                Err(e) => tracing::warn!("pprof-gateway connect failed: {e}; retrying in 30s"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

async fn run_gateway_session(
    ws_url: &str,
    hostname: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use base64::Engine;
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await?;

    // Register; gateway replies with our connection id.
    ws.send(Message::Text(
        serde_json::json!({"service": "frontend", "hostname": hostname}).to_string().into(),
    ))
    .await?;
    let Some(Ok(Message::Text(reply))) = ws.next().await else {
        return Err("no registration reply".into());
    };
    let conn_id = serde_json::from_str::<serde_json::Value>(&reply)?
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    tracing::info!("connected to pprof gateway as {hostname} (id={conn_id})");

    while let Some(msg) = ws.next().await {
        let Message::Text(text) = msg? else { continue };
        let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) else { continue };

        // Statsviz relay is Go-specific: report unsupported instead of hanging.
        if let Some(t) = req.get("type").and_then(|v| v.as_str())
            && t == "statsviz_start"
        {
            let id = req.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            ws.send(Message::Text(
                serde_json::json!({
                    "type": "statsviz_error", "id": id,
                    "error": "statsviz not supported by rari",
                })
                .to_string()
                .into(),
            ))
            .await?;
            continue;
        }

        let (Some(id), Some(url)) = (
            req.get("id").and_then(|v| v.as_str()),
            req.get("url").and_then(|v| v.as_str()),
        ) else {
            continue;
        };

        let response = match url.split('?').next().unwrap_or(url) {
            "/debug/pprof/heap" => match dump_heap_pprof().await {
                Ok(pprof) => serde_json::json!({
                    "id": id, "status_code": 200,
                    "headers": {},
                    "body": base64::engine::general_purpose::STANDARD.encode(&pprof),
                    "content_type": "application/octet-stream",
                    "error": "",
                }),
                Err(e) => serde_json::json!({
                    "id": id, "status_code": 500, "headers": {}, "body": "",
                    "content_type": "", "error": e,
                }),
            },
            other => serde_json::json!({
                "id": id, "status_code": 404, "headers": {}, "body": "",
                "content_type": "",
                "error": format!("profile {other} not supported by rari (heap only)"),
            }),
        };

        ws.send(Message::Text(response.to_string().into())).await?;
    }
    Ok(())
}

async fn dump_heap_pprof() -> Result<Vec<u8>, String> {
    let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
        return Err("jemalloc profiling unavailable".to_string());
    };
    let mut ctl = prof_ctl.lock().await;
    if !ctl.activated() {
        return Err("heap profiling not active; run with MALLOC_CONF=prof:true,prof_active:true"
            .to_string());
    }
    let pprof = ctl.dump_pprof().map_err(|e| e.to_string());
    // See the pusher: don't leave the symbolization DWARF cache resident.
    backtrace::clear_symbol_cache();
    pprof
}

/// `GET /_rari/metrics` — jemalloc allocator stats, cache gauges, and the
/// per-route SSR latency histogram in Prometheus text format.
pub async fn metrics_handler(
    axum::extract::State(state): axum::extract::State<crate::server::types::ServerState>,
) -> impl IntoResponse {
    // Stats are cached per epoch; advance it so the read reflects current usage.
    if let Err(e) = epoch::advance() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("# jemalloc epoch advance failed: {e}\n"),
        )
            .into_response();
    }

    let mut body = String::with_capacity(2048);
    {
        let mut gauge = |name: &str, read: Result<usize, tikv_jemalloc_ctl::Error>| {
            if let Ok(v) = read {
                body.push_str(&format!(
                    "# TYPE rari_jemalloc_{name}_bytes gauge\nrari_jemalloc_{name}_bytes {v}\n"
                ));
            }
        };
        // allocated: bytes in live allocations. active: bytes in active pages.
        // resident: physical RSS jemalloc controls. retained: virtual, unmapped, reusable.
        // mapped/metadata: total mapping + jemalloc bookkeeping.
        gauge("allocated", stats::allocated::read());
        gauge("active", stats::active::read());
        gauge("resident", stats::resident::read());
        gauge("retained", stats::retained::read());
        gauge("mapped", stats::mapped::read());
        gauge("metadata", stats::metadata::read());
    }

    // Response cache (bodies + compressed variants; byte-capped since
    // cachefix.4). These would have made the unbounded-cache OOM visible in
    // one Grafana panel.
    let rc = state.response_cache.get_metrics();
    body.push_str(&format!(
        "# TYPE rari_response_cache_bytes gauge\nrari_response_cache_bytes {}\n\
         # TYPE rari_response_cache_entries gauge\nrari_response_cache_entries {}\n\
         # TYPE rari_response_cache_hits_total counter\nrari_response_cache_hits_total {}\n\
         # TYPE rari_response_cache_misses_total counter\nrari_response_cache_misses_total {}\n\
         # TYPE rari_response_cache_evictions_total counter\nrari_response_cache_evictions_total {}\n",
        rc.memory_usage_bytes, rc.total_entries, rc.cache_hits, rc.cache_misses, rc.evictions,
    ));

    // Layout HTML cache (rendered pages keyed by route+params; byte-capped
    // since cachefix.6).
    body.push_str(&format!(
        "# TYPE rari_layout_cache_bytes gauge\nrari_layout_cache_bytes {}\n\
         # TYPE rari_layout_cache_entries gauge\nrari_layout_cache_entries {}\n",
        state.layout_html_cache.bytes(),
        state.layout_html_cache.entries(),
    ));

    crate::server::metrics_http::render_prometheus(&mut body);

    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

/// `GET /_rari/debug/heap` — dump a symbolized pprof heap profile.
pub async fn heap_dump_handler(headers: HeaderMap) -> impl IntoResponse {
    // Auth: require RARI_PROFILING_TOKEN to be set and matched. Fail closed.
    match std::env::var("RARI_PROFILING_TOKEN") {
        Ok(token) if !token.is_empty() => {
            let provided =
                headers.get("x-rari-profiling-token").and_then(|v| v.to_str().ok()).unwrap_or("");
            if provided.as_bytes() != token.as_bytes() {
                return (StatusCode::UNAUTHORIZED, "invalid profiling token").into_response();
            }
        }
        _ => {
            return (
                StatusCode::FORBIDDEN,
                "heap dump disabled: set RARI_PROFILING_TOKEN and run with \
                 MALLOC_CONF=prof:true,prof_active:true",
            )
                .into_response();
        }
    }

    let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "jemalloc profiling unavailable").into_response();
    };
    let mut prof_ctl = prof_ctl.lock().await;
    if !prof_ctl.activated() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "heap profiling not active; run with MALLOC_CONF=prof:true,prof_active:true",
        )
            .into_response();
    }

    match prof_ctl.dump_pprof() {
        Ok(pprof) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"rari-heap.pb.gz\""),
            ],
            pprof,
        )
            .into_response(),
        Err(e) => {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("dump_pprof failed: {e}")).into_response()
        }
    }
}

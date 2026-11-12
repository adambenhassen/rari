use std::{
    env,
    error::Error,
    fmt::Write as _,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use tikv_jemalloc_ctl::{epoch, stats};
use tokio::time::sleep;

use crate::server::{host::types::ServerState, metrics_http::render_prometheus};

enum HeapDumpError {
    Unavailable,
    Inactive,
    Failed(String),
}

const PYROSCOPE_INTERVAL: Duration = Duration::from_secs(60);

impl HeapDumpError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Unavailable | Self::Inactive => StatusCode::SERVICE_UNAVAILABLE,
            Self::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Unavailable => "jemalloc profiling unavailable".to_string(),
            Self::Inactive => {
                "heap profiling not active; run with MALLOC_CONF=prof:true,prof_active:true"
                    .to_string()
            }
            Self::Failed(error) => format!("dump_pprof failed: {error}"),
        }
    }
}

/// Send heap profiles to Pyroscope when the deployment configures an endpoint.
pub fn spawn_pyroscope_pusher() {
    let Ok(server) = env::var("PYROSCOPE_URL") else {
        return;
    };
    if server.is_empty() {
        return;
    }

    let app = env::var("PYROSCOPE_APP_NAME").unwrap_or_else(|_| "frontend".to_string());
    let pod = env::var("POD_NAME")
        .or_else(|_| env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let node = env::var("NODE_NAME").unwrap_or_else(|_| "unknown".to_string());

    tokio::spawn(async move {
        let name = format!("{app}{{pod={pod},node={node}}}");
        let client = reqwest::Client::new();
        let mut last_logged_err = false;
        loop {
            sleep(PYROSCOPE_INTERVAL).await;

            let pprof = match dump_heap_pprof().await {
                Ok(pprof) => pprof,
                Err(HeapDumpError::Unavailable | HeapDumpError::Inactive) => continue,
                Err(error) => {
                    tracing::warn!(error = %error.message(), "Pyroscope heap dump failed");
                    continue;
                }
            };

            let until = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            let from = until.saturating_sub(PYROSCOPE_INTERVAL.as_secs());
            let ingest_url = format!("{}/ingest", server.trim_end_matches('/'));
            let Ok(mut url) = url::Url::parse(&ingest_url) else {
                tracing::warn!("Invalid PYROSCOPE_URL: {server}");
                return;
            };
            url.query_pairs_mut()
                .append_pair("name", &name)
                .append_pair("from", &from.to_string())
                .append_pair("until", &until.to_string())
                .append_pair("format", "pprof");

            match client.post(url).body(pprof).send().await {
                Ok(response) if response.status().is_success() => last_logged_err = false,
                Ok(response) if !last_logged_err => {
                    tracing::warn!(status = %response.status(), "Pyroscope ingest failed");
                    last_logged_err = true;
                }
                Err(error) if !last_logged_err => {
                    tracing::warn!(%error, "Pyroscope ingest failed");
                    last_logged_err = true;
                }
                Ok(_) | Err(_) => {}
            }
        }
    });
}

/// Reverse-connect to the pprof gateway and serve its heap profile requests.
pub fn spawn_pprof_gateway_client() {
    let Ok(gateway) = env::var("PPROF_GATEWAY_URL") else {
        return;
    };
    if gateway.is_empty() {
        return;
    }

    let mut hostname = env::var("HOSTNAME").unwrap_or_else(|_| "rari-unknown".to_string());
    if let Ok(node) = env::var("NODE_NAME") {
        hostname = format!("{hostname}@{node}");
    }

    tokio::spawn(async move {
        let gateway = gateway.trim_end_matches('/');
        let ws_url = if let Some(rest) = gateway.strip_prefix("https://") {
            format!("wss://{rest}/connect")
        } else if let Some(rest) = gateway.strip_prefix("http://") {
            format!("ws://{rest}/connect")
        } else {
            format!("{gateway}/connect")
        };

        loop {
            match run_gateway_session(&ws_url, &hostname).await {
                Ok(()) => tracing::info!("pprof gateway session closed; reconnecting"),
                Err(error) => tracing::warn!(%error, "pprof gateway connection failed; retrying"),
            }
            sleep(Duration::from_secs(30)).await;
        }
    });
}

async fn run_gateway_session(
    ws_url: &str,
    hostname: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await?;
    ws.send(Message::Text(
        serde_json::json!({"service": "frontend", "hostname": hostname}).to_string().into(),
    ))
    .await?;

    let Some(Ok(Message::Text(reply))) = ws.next().await else {
        return Err("no pprof gateway registration reply".into());
    };
    let connection_id = serde_json::from_str::<serde_json::Value>(&reply)?
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?")
        .to_string();
    tracing::info!(%hostname, %connection_id, "Connected to pprof gateway");

    while let Some(message) = ws.next().await {
        let Message::Text(text) = message? else { continue };
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&text) else { continue };

        if request.get("type").and_then(serde_json::Value::as_str) == Some("statsviz_start") {
            let id = request.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
            ws.send(Message::Text(
                serde_json::json!({
                    "type": "statsviz_error",
                    "id": id,
                    "error": "statsviz not supported by rari",
                })
                .to_string()
                .into(),
            ))
            .await?;
            continue;
        }

        let (Some(id), Some(url)) = (
            request.get("id").and_then(serde_json::Value::as_str),
            request.get("url").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };

        let response = match url.split('?').next().unwrap_or(url) {
            "/debug/pprof/heap" => match dump_heap_pprof().await {
                Ok(pprof) => serde_json::json!({
                    "id": id,
                    "status_code": 200,
                    "headers": {},
                    "body": STANDARD.encode(pprof),
                    "content_type": "application/octet-stream",
                    "error": "",
                }),
                Err(error) => serde_json::json!({
                    "id": id,
                    "status_code": error.status().as_u16(),
                    "headers": {},
                    "body": "",
                    "content_type": "",
                    "error": error.message(),
                }),
            },
            path => serde_json::json!({
                "id": id,
                "status_code": 404,
                "headers": {},
                "body": "",
                "content_type": "",
                "error": format!("profile {path} not supported by rari (heap only)"),
            }),
        };
        ws.send(Message::Text(response.to_string().into())).await?;
    }
    Ok(())
}

async fn dump_heap_pprof() -> Result<Vec<u8>, HeapDumpError> {
    let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
        return Err(HeapDumpError::Unavailable);
    };
    let result = {
        let mut prof_ctl = prof_ctl.lock().await;
        if !prof_ctl.activated() {
            return Err(HeapDumpError::Inactive);
        }
        prof_ctl.dump_pprof()
    };
    backtrace::clear_symbol_cache();
    result.map_err(|error| HeapDumpError::Failed(error.to_string()))
}

/// `GET /_rari/debug/heap` — return a symbolized pprof heap profile.
pub async fn heap_dump_handler(headers: HeaderMap) -> impl IntoResponse {
    if let Some(response) =
        heap_dump_authorization_error(&headers, env::var("RARI_PROFILING_TOKEN").ok().as_deref())
    {
        return response;
    }

    no_store(match dump_heap_pprof().await {
        Ok(pprof) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"rari-heap.pb.gz\""),
            ],
            pprof,
        )
            .into_response(),
        Err(error) => (error.status(), error.message()).into_response(),
    })
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn heap_dump_authorization_error(headers: &HeaderMap, token: Option<&str>) -> Option<Response> {
    match token {
        Some(token) if !token.is_empty() => {
            let provided = headers
                .get("x-rari-profiling-token")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            if provided.as_bytes() == token.as_bytes() {
                None
            } else {
                Some(no_store(
                    (StatusCode::UNAUTHORIZED, "invalid profiling token").into_response(),
                ))
            }
        }
        _ => Some(no_store(
            (
                StatusCode::FORBIDDEN,
                "heap dump disabled: set RARI_PROFILING_TOKEN and enable jemalloc profiling",
            )
                .into_response(),
        )),
    }
}

pub async fn metrics_handler(State(state): State<ServerState>) -> impl IntoResponse {
    if let Err(error) = epoch::advance() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("# jemalloc epoch advance failed: {error}\n"),
        )
            .into_response();
    }

    let mut body = String::with_capacity(2048);
    for (name, value) in [
        ("allocated", stats::allocated::read()),
        ("active", stats::active::read()),
        ("resident", stats::resident::read()),
        ("retained", stats::retained::read()),
        ("mapped", stats::mapped::read()),
        ("metadata", stats::metadata::read()),
    ] {
        if let Ok(value) = value {
            let _ = writeln!(
                body,
                "# TYPE rari_jemalloc_{name}_bytes gauge\nrari_jemalloc_{name}_bytes {value}"
            );
        }
    }

    let response_cache = state.response_cache.get_metrics();
    let _ = write!(
        body,
        "# TYPE rari_response_cache_bytes gauge\nrari_response_cache_bytes {}\n\
         # TYPE rari_response_cache_entries gauge\nrari_response_cache_entries {}\n\
         # TYPE rari_response_cache_hits_total counter\nrari_response_cache_hits_total {}\n\
         # TYPE rari_response_cache_misses_total counter\nrari_response_cache_misses_total {}\n\
         # TYPE rari_response_cache_evictions_total counter\nrari_response_cache_evictions_total {}\n",
        response_cache.memory_usage_bytes,
        response_cache.total_entries,
        response_cache.cache_hits,
        response_cache.cache_misses,
        response_cache.evictions,
    );

    let (layout_entries, layout_bytes) = state.layout_html_cache.get_metrics();
    let _ = write!(
        body,
        "# TYPE rari_layout_cache_bytes gauge\nrari_layout_cache_bytes {layout_bytes}\n\
         # TYPE rari_layout_cache_entries gauge\nrari_layout_cache_entries {layout_entries}\n"
    );

    render_prometheus(&mut body);

    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use super::*;

    fn assert_denied(response: Response, status: StatusCode) {
        assert_eq!(response.status(), status);
        assert!(
            response.headers().get(header::CACHE_CONTROL).is_some_and(|value| value == "no-store")
        );
    }

    #[test]
    fn heap_dump_requires_profiling_to_be_enabled() {
        let response = heap_dump_authorization_error(&HeaderMap::new(), None)
            .expect("missing profiling token denies access");

        assert_denied(response, StatusCode::FORBIDDEN);
    }

    #[test]
    fn heap_dump_rejects_missing_or_invalid_profiling_tokens() {
        let token = "test-token";
        let missing = heap_dump_authorization_error(&HeaderMap::new(), Some(token))
            .expect("missing request token denies access");
        assert_denied(missing, StatusCode::UNAUTHORIZED);

        let mut headers = HeaderMap::new();
        headers.insert("x-rari-profiling-token", HeaderValue::from_static("wrong-token"));
        let invalid = heap_dump_authorization_error(&headers, Some(token))
            .expect("invalid request token denies access");
        assert_denied(invalid, StatusCode::UNAUTHORIZED);

        headers.insert("x-rari-profiling-token", HeaderValue::from_static(token));
        assert!(heap_dump_authorization_error(&headers, Some(token)).is_none());
    }
}

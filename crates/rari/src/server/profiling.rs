use std::{
    env,
    error::Error,
    fmt::Write as _,
    io,
    sync::Arc,
    time::{Duration, SystemTime, SystemTimeError, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use tikv_jemalloc_ctl::{epoch, stats};
use tokio::{
    task::{self, JoinError},
    time::{sleep, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::server::{host::types::ServerState, metrics_http::render_prometheus};

enum HeapDumpError {
    Unavailable,
    Inactive,
    Failed(String),
}

const PYROSCOPE_INTERVAL: Duration = Duration::from_secs(60);
const PYROSCOPE_PUSH_TIMEOUT: Duration = Duration::from_secs(10);
const PPROF_GATEWAY_TIMEOUT: Duration = Duration::from_secs(5);

fn pyroscope_ingest_url(server: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(server).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("PYROSCOPE_URL must use http or https and include a host".to_string());
    }
    let path = format!("{}/ingest", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn pyroscope_http_client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder().timeout(timeout).build()
}

fn pyroscope_time_range(now: SystemTime) -> Result<(u64, u64), SystemTimeError> {
    let until = now.duration_since(UNIX_EPOCH)?.as_secs();
    Ok((until.saturating_sub(PYROSCOPE_INTERVAL.as_secs()), until))
}

async fn run_heap_dump_on_blocking_thread<T: Send + 'static>(
    dump: impl FnOnce() -> T + Send + 'static,
) -> Result<T, JoinError> {
    task::spawn_blocking(dump).await
}

impl HeapDumpError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Unavailable | Self::Inactive => StatusCode::SERVICE_UNAVAILABLE,
            Self::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Unavailable => {
                "jemalloc profiling unavailable; build the binary with the jemalloc feature and set MALLOC_CONF=prof:true,prof_active:true".to_string()
            }
            Self::Inactive => {
                "heap profiling inactive; set MALLOC_CONF=prof:true,prof_active:true and build the binary with the jemalloc feature".to_string()
            }
            Self::Failed(error) => format!("dump_pprof failed: {error}; check jemalloc profiling configuration"),
        }
    }
}

async fn heap_profiling_status() -> Result<(), HeapDumpError> {
    let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
        return Err(HeapDumpError::Unavailable);
    };
    if prof_ctl.lock().await.activated() { Ok(()) } else { Err(HeapDumpError::Inactive) }
}

/// Send heap profiles to Pyroscope when the deployment configures an endpoint.
pub fn spawn_pyroscope_pusher() {
    let Ok(server) = env::var("PYROSCOPE_URL") else {
        return;
    };
    if server.is_empty() {
        return;
    }
    let ingest_url = match pyroscope_ingest_url(&server) {
        Ok(url) => url,
        Err(error) => {
            tracing::warn!(%error, "Invalid PYROSCOPE_URL; configure an http(s) endpoint with a host");
            return;
        }
    };
    let client = match pyroscope_http_client(PYROSCOPE_PUSH_TIMEOUT) {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "Could not create the Pyroscope HTTP client; check its TLS configuration");
            return;
        }
    };

    let app = env::var("PYROSCOPE_APP_NAME").unwrap_or_else(|_| "frontend".to_string());
    let pod = env::var("POD_NAME")
        .or_else(|_| env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let node = env::var("NODE_NAME").unwrap_or_else(|_| "unknown".to_string());

    tokio::spawn(async move {
        let name = format!("{app}{{pod={pod},node={node}}}");
        let mut last_logged_err = false;
        let mut profile_unavailable_logged = false;
        if let Err(error) = heap_profiling_status().await {
            tracing::warn!(error = %error.message(), "Pyroscope is configured but heap profiling is unavailable");
            profile_unavailable_logged = true;
        }
        loop {
            sleep(PYROSCOPE_INTERVAL).await;

            let pprof = match dump_heap_pprof().await {
                Ok(pprof) => pprof,
                Err(error @ (HeapDumpError::Unavailable | HeapDumpError::Inactive)) => {
                    if !profile_unavailable_logged {
                        tracing::warn!(error = %error.message(), "Pyroscope is configured but heap profiling is unavailable");
                        profile_unavailable_logged = true;
                    }
                    continue;
                }
                Err(error) => {
                    tracing::warn!(error = %error.message(), "Pyroscope heap dump failed");
                    continue;
                }
            };

            let (from, until) = match pyroscope_time_range(SystemTime::now()) {
                Ok(range) => range,
                Err(error) => {
                    tracing::warn!(%error, "Could not read the clock for Pyroscope profile timestamps; skipping this push");
                    continue;
                }
            };
            let mut url = ingest_url.clone();
            url.query_pairs_mut()
                .append_pair("name", &name)
                .append_pair("from", &from.to_string())
                .append_pair("until", &until.to_string())
                .append_pair("format", "pprof");

            match client.post(url).body(pprof).send().await {
                Ok(response) if response.status().is_success() => last_logged_err = false,
                Ok(response) if !last_logged_err => {
                    tracing::warn!(status = %response.status(), "Pyroscope ingest returned an error; check the endpoint and ingestion credentials");
                    last_logged_err = true;
                }
                Err(error) if error.is_timeout() => {
                    tracing::warn!(%error, "Pyroscope profile push timed out; check endpoint reachability and response time");
                    last_logged_err = true;
                }
                Err(error) if !last_logged_err => {
                    tracing::warn!(%error, "Pyroscope ingest failed; check endpoint reachability");
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
                Err(error) => {
                    tracing::warn!(%error, "pprof gateway connection failed; check PPROF_GATEWAY_URL and gateway reachability before retrying");
                }
            }
            sleep(Duration::from_secs(30)).await;
        }
    });
}

#[expect(
    clippy::too_many_lines,
    reason = "The gateway session keeps registration and request correlation in one protocol flow"
)]
async fn run_gateway_session(
    ws_url: &str,
    hostname: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let (mut ws, _) =
        timeout(PPROF_GATEWAY_TIMEOUT, connect_async(ws_url)).await.map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, "pprof gateway websocket connect timed out")
        })??;
    timeout(
        PPROF_GATEWAY_TIMEOUT,
        ws.send(Message::Text(
            serde_json::json!({"service": "frontend", "hostname": hostname}).to_string().into(),
        )),
    )
    .await
    .map_err(|_| {
        io::Error::new(io::ErrorKind::TimedOut, "pprof gateway registration send timed out")
    })??;
    let reply = timeout(PPROF_GATEWAY_TIMEOUT, ws.next())
        .await
        .map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, "pprof gateway registration reply timed out")
        })?
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::UnexpectedEof, "no pprof gateway registration reply")
        })??;
    let Message::Text(reply) = reply else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "pprof gateway registration reply was not text",
        )
        .into());
    };
    let connection_id = serde_json::from_str::<serde_json::Value>(&reply)?
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "pprof gateway registration reply is missing a string id",
            )
        })?
        .to_string();
    tracing::info!(%hostname, %connection_id, "Connected to pprof gateway");

    while let Some(message) = ws.next().await {
        let Message::Text(text) = message? else { continue };
        let request = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(request)) => serde_json::Value::Object(request),
            Ok(_) => {
                tracing::warn!(
                    "Malformed pprof gateway request; send a JSON object with string id and url fields"
                );
                continue;
            }
            Err(error) => {
                tracing::warn!(%error, "Malformed pprof gateway request JSON; check the gateway request serialization");
                continue;
            }
        };
        let Some(id) =
            request.get("id").and_then(serde_json::Value::as_str).filter(|id| !id.is_empty())
        else {
            tracing::warn!(
                "Malformed pprof gateway request has no string id; provide a string id so an error reply can be correlated"
            );
            continue;
        };

        if request.get("type").and_then(serde_json::Value::as_str) == Some("statsviz_start") {
            timeout(
                PPROF_GATEWAY_TIMEOUT,
                ws.send(Message::Text(
                    serde_json::json!({
                        "type": "statsviz_error",
                        "id": id,
                        "error": "statsviz not supported by rari",
                    })
                    .to_string()
                    .into(),
                )),
            )
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "pprof gateway response send timed out")
            })??;
            continue;
        }

        let Some(url) = request.get("url").and_then(serde_json::Value::as_str) else {
            tracing::warn!(request_id = %id, "Malformed pprof gateway request is missing a string url; provide a url to request a profile, replying with an error");
            timeout(
                PPROF_GATEWAY_TIMEOUT,
                ws.send(Message::Text(
                    serde_json::json!({
                        "id": id,
                        "status_code": 400,
                        "headers": {},
                        "body": "",
                        "content_type": "",
                        "error": "malformed pprof request: missing string url",
                    })
                    .to_string()
                    .into(),
                )),
            )
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "pprof gateway response send timed out")
            })??;
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
                Err(error) => {
                    let message = error.message();
                    tracing::error!(request_id = %id, error = %message, "pprof gateway heap dump failed");
                    serde_json::json!({
                        "id": id,
                        "status_code": error.status().as_u16(),
                        "headers": {},
                        "body": "",
                        "content_type": "",
                        "error": message,
                    })
                }
            },
            path => {
                tracing::warn!(request_id = %id, profile_path = path, "Unsupported pprof gateway profile; request /debug/pprof/heap for a heap profile");
                serde_json::json!({
                    "id": id,
                    "status_code": 404,
                    "headers": {},
                    "body": "",
                    "content_type": "",
                    "error": format!("profile {path} not supported by rari (heap only)"),
                })
            }
        };
        timeout(PPROF_GATEWAY_TIMEOUT, ws.send(Message::Text(response.to_string().into())))
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "pprof gateway response send timed out")
            })??;
    }
    Ok(())
}

async fn dump_heap_pprof() -> Result<Vec<u8>, HeapDumpError> {
    let Some(prof_ctl) = jemalloc_pprof::PROF_CTL.as_ref() else {
        return Err(HeapDumpError::Unavailable);
    };
    let prof_ctl = Arc::clone(prof_ctl);
    run_heap_dump_on_blocking_thread(move || {
        let mut prof_ctl = prof_ctl.blocking_lock();
        if !prof_ctl.activated() {
            return Err(HeapDumpError::Inactive);
        }
        let result =
            prof_ctl.dump_pprof().map_err(|error| HeapDumpError::Failed(error.to_string()));
        backtrace::clear_symbol_cache();
        result
    })
    .await
    .map_err(|error| HeapDumpError::Failed(format!("blocking heap dump task failed: {error}")))?
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
        Err(error) => {
            let message = error.message();
            tracing::error!(error = %message, "HTTP heap dump failed");
            (error.status(), message).into_response()
        }
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
                "heap dump disabled: set RARI_PROFILING_TOKEN, build with the jemalloc feature, and set MALLOC_CONF=prof:true,prof_active:true",
            )
                .into_response(),
        )),
    }
}

pub async fn metrics_handler(State(state): State<ServerState>) -> impl IntoResponse {
    if let Err(error) = epoch::advance() {
        tracing::warn!(%error, "Failed to advance jemalloc epoch; allocator metrics are unavailable, verify jemalloc configuration");
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
        match value {
            Ok(value) => {
                let _ = writeln!(
                    body,
                    "# TYPE rari_jemalloc_{name}_bytes gauge\nrari_jemalloc_{name}_bytes {value}"
                );
            }
            Err(error) => {
                tracing::warn!(stat = name, %error, "Failed to read jemalloc metric; verify jemalloc stats are available, omitting this series");
            }
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
    let _ = writeln!(
        body,
        "# TYPE rari_layout_cache_entries gauge\nrari_layout_cache_entries {layout_entries}"
    );
    if let Some(layout_bytes) = layout_bytes {
        let _ = writeln!(
            body,
            "# TYPE rari_layout_cache_bytes gauge\nrari_layout_cache_bytes {layout_bytes}"
        );
    }

    render_prometheus(&mut body);

    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body).into_response()
}

#[cfg(test)]
#[expect(clippy::expect_used)]
mod tests {
    use std::thread;

    use futures::{SinkExt, StreamExt};
    use tokio::{net::TcpListener, time::sleep};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    fn assert_denied(response: &Response, status: StatusCode) {
        assert_eq!(response.status(), status);
        assert!(
            response.headers().get(header::CACHE_CONTROL).is_some_and(|value| value == "no-store")
        );
    }

    #[test]
    fn heap_dump_requires_profiling_to_be_enabled() {
        let response = heap_dump_authorization_error(&HeaderMap::new(), None)
            .expect("missing profiling token denies access");

        assert_denied(&response, StatusCode::FORBIDDEN);
    }

    #[test]
    fn heap_dump_rejects_missing_or_invalid_profiling_tokens() {
        let token = "test-token";
        let missing = heap_dump_authorization_error(&HeaderMap::new(), Some(token))
            .expect("missing request token denies access");
        assert_denied(&missing, StatusCode::UNAUTHORIZED);

        let mut headers = HeaderMap::new();
        headers.insert("x-rari-profiling-token", HeaderValue::from_static("wrong-token"));
        let invalid = heap_dump_authorization_error(&headers, Some(token))
            .expect("invalid request token denies access");
        assert_denied(&invalid, StatusCode::UNAUTHORIZED);

        headers.insert("x-rari-profiling-token", HeaderValue::from_static(token));
        assert!(heap_dump_authorization_error(&headers, Some(token)).is_none());
    }

    #[test]
    fn unavailable_heap_dump_message_names_the_feature_and_runtime_setting() {
        let message = HeapDumpError::Unavailable.message();

        assert!(message.contains("jemalloc feature"));
        assert!(message.contains("MALLOC_CONF"));
    }

    #[test]
    fn pyroscope_rejects_non_http_ingest_urls() {
        assert!(pyroscope_ingest_url("file:///tmp/profile").is_err());
    }

    #[test]
    fn pyroscope_time_range_rejects_a_clock_before_the_epoch() {
        let before_epoch = UNIX_EPOCH - Duration::from_secs(1);

        assert!(pyroscope_time_range(before_epoch).is_err());
    }

    #[tokio::test]
    async fn symbolized_heap_dump_runs_off_the_async_worker() {
        let async_thread = thread::current().id();

        let dump_thread = run_heap_dump_on_blocking_thread(|| thread::current().id())
            .await
            .expect("blocking task should complete");

        assert_ne!(dump_thread, async_thread);
    }

    #[tokio::test]
    async fn pyroscope_client_times_out_a_stalled_push() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind local HTTP server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept client");
            let mut request = [0; 1024];
            let _bytes_read = stream.read(&mut request).await.expect("read HTTP request");
            sleep(Duration::from_millis(100)).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("send HTTP response");
        });
        let client = pyroscope_http_client(Duration::from_millis(20)).expect("build HTTP client");

        let result = client.get(format!("http://{address}/ingest")).send().await;

        server.abort();
        assert!(result.expect_err("stalled server should time out").is_timeout());
    }

    #[tokio::test]
    async fn pprof_gateway_rejects_a_registration_reply_without_an_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind local websocket server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept gateway connection");
            let mut ws = accept_async(stream).await.expect("accept websocket");
            let _registration =
                ws.next().await.expect("registration request").expect("valid registration frame");
            ws.send(Message::Text(r#"{"hostname":"rari-test"}"#.into()))
                .await
                .expect("send registration reply");
        });

        let result = run_gateway_session(&format!("ws://{address}/connect"), "rari-test").await;

        server.await.expect("gateway server task");
        assert!(result.is_err(), "registration without a string id must fail");
    }

    #[tokio::test]
    async fn pprof_gateway_answers_malformed_requests_when_the_id_is_known() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind local websocket server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept gateway connection");
            let mut ws = accept_async(stream).await.expect("accept websocket");
            let _registration =
                ws.next().await.expect("registration request").expect("valid registration frame");
            ws.send(Message::Text(r#"{"id":"connection-1"}"#.into()))
                .await
                .expect("send registration reply");
            ws.send(Message::Text(r#"{"id":"request-1"}"#.into()))
                .await
                .expect("send malformed profile request");

            let reply = timeout(Duration::from_secs(1), ws.next())
                .await
                .expect("malformed request should receive an error reply")
                .expect("gateway session should stay open")
                .expect("valid response frame");
            let reply = match reply {
                Message::Text(reply) => reply.to_string(),
                _ => String::new(),
            };
            let response: serde_json::Value =
                serde_json::from_str(&reply).expect("valid error response");

            assert_eq!(response["id"], "request-1");
            assert_eq!(response["status_code"], 400);
            assert_ne!(response["error"].as_str().unwrap_or_default(), "");
        });

        let _ = run_gateway_session(&format!("ws://{address}/connect"), "rari-test").await;

        server.await.expect("gateway server task");
    }

    #[tokio::test]
    async fn pprof_gateway_connection_handshake_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind local websocket server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept gateway connection");
            sleep(Duration::from_secs(10)).await;
        });

        let result = timeout(
            Duration::from_secs(8),
            run_gateway_session(&format!("ws://{address}/connect"), "rari-test"),
        )
        .await;

        server.abort();
        assert!(matches!(result, Ok(Err(_))), "websocket handshake should time out internally");
    }

    #[tokio::test]
    async fn pprof_gateway_registration_reply_wait_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind local websocket server");
        let address = listener.local_addr().expect("local address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept gateway connection");
            let mut ws = accept_async(stream).await.expect("accept websocket");
            let _registration =
                ws.next().await.expect("registration request").expect("valid registration frame");
            sleep(Duration::from_secs(10)).await;
        });

        let result = timeout(
            Duration::from_secs(8),
            run_gateway_session(&format!("ws://{address}/connect"), "rari-test"),
        )
        .await;

        server.abort();
        assert!(matches!(result, Ok(Err(_))), "registration reply should time out internally");
    }
}

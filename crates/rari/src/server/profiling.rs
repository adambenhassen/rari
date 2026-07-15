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

/// `GET /_rari/metrics` — jemalloc allocator stats as Prometheus gauges (bytes).
pub async fn metrics_handler() -> impl IntoResponse {
    // Stats are cached per epoch; advance it so the read reflects current usage.
    if let Err(e) = epoch::advance() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("# jemalloc epoch advance failed: {e}\n"),
        )
            .into_response();
    }

    let mut body = String::with_capacity(512);
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

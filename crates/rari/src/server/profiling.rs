use std::fmt::Write as _;

use axum::{
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use tikv_jemalloc_ctl::{epoch, stats};

use crate::server::{host::types::ServerState, metrics_http::render_prometheus};

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

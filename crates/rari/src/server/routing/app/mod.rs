mod cache;
mod render;
mod route;

use axum::{body::Body, http::StatusCode, response::Response};

pub(super) fn response_unavailable(
    body: Body,
    content_type: &str,
    retry_after_seconds: u64,
) -> Response {
    #[expect(clippy::expect_used, reason = "all response headers use valid values")]
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .header("retry-after", retry_after_seconds.to_string())
        .body(body)
        .expect("Valid service unavailable response")
}

pub(crate) use render::{collect_page_metadata, wrap_html_with_metadata};
pub use render::{
    render_fallback_html, render_rsc_navigation_streaming, render_streaming_with_layout,
    render_synchronous, render_with_fallback,
};
pub use route::handle_app_route;

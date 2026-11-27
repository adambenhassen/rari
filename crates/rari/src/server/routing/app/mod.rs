pub(crate) mod cache;
mod render;
mod route;

use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::Response,
};

use crate::server::middleware::request_context::RequestContext;

pub(super) fn apply_request_no_store(
    mut response: Response,
    request_context: &RequestContext,
) -> Response {
    if request_context.must_send_no_store() {
        response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

pub(super) fn apply_request_cache_policy(
    mut response: Response,
    request_context: &RequestContext,
) -> Response {
    if request_context.must_send_no_store() {
        response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else if request_context.metadata_uses_request_data() {
        response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    }
    response
}

#[cfg(test)]
mod tests {
    use axum::{http::header::CACHE_CONTROL, response::Response};

    use super::apply_request_cache_policy;
    use crate::server::middleware::request_context::{RequestContext, RequestDataAccessScope};

    #[test]
    fn request_data_metadata_responses_use_private_revalidating_cache_policy() {
        let request_context = RequestContext::new("/session".to_string());
        request_context.mark_request_data_access(RequestDataAccessScope::Metadata);
        let response = Response::builder()
            .header(CACHE_CONTROL, "public, max-age=600")
            .body(axum::body::Body::empty())
            .expect("valid test response");

        let response = apply_request_cache_policy(response, &request_context);

        assert_eq!(response.headers()[CACHE_CONTROL], "private, no-cache");
    }
}

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

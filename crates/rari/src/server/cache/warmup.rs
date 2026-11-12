use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

use axum::http::HeaderMap;
use futures::stream::{self, StreamExt};
use rari_error::RariError;
use rustc_hash::FxHashMap;
use tokio::sync::{Mutex, OnceCell};

use crate::{
    rendering::layout::{
        ChunkedContentType, LayoutRenderContext, LayoutRenderer, drain_chunked_stream,
        types::RenderResult,
    },
    server::{
        ServerState,
        cache::response,
        compression::compress_all_encodings,
        middleware::request_context::RequestContext,
        routing::{
            AppRouteMatch, AppRouter,
            app::{collect_page_metadata, wrap_html_with_metadata},
            types::ParamValue,
        },
    },
};

const WARMUP_CONCURRENCY: usize = 10;

struct WarmupHtmlCacheEntry {
    path: String,
    key: String,
    prebuilt: Arc<response::PrebuiltResponse>,
    response: response::CachedResponse,
    max_entries: usize,
}

struct WarmupResponseCacheEntry {
    key: String,
    response: response::CachedResponse,
}

fn is_warmup_interrupted(error: &RariError) -> bool {
    error.get_property("cancelled") == Some("true")
}

fn wrap_warmup_render_error(error: &RariError) -> RariError {
    let cancelled = error.get_property("cancelled") == Some("true");
    let mut wrapped = RariError::internal(format!("Render failed: {error}"));
    if cancelled {
        wrapped.set_property("cancelled", "true");
    }
    wrapped
}

/// Serialize warmup renders to prevent V8 global state corruption.
/// The RSC+Fizz pipeline shares V8 globals between the mutex-protected
/// RSC render and the non-mutex Fizz render. Without serialization,
/// concurrent warmup tasks interleave and produce wrong HTML.
///
/// The guard must cover both the HTML/Fizz render and the follow-up RSC
/// render in [`warm_route`], not only the first call.
static WARMUP_RENDER_LOCK: OnceCell<Arc<Mutex<()>>> = OnceCell::const_new();

async fn warmup_render_lock() -> Arc<Mutex<()>> {
    Arc::clone(WARMUP_RENDER_LOCK.get_or_init(|| async { Arc::new(Mutex::new(())) }).await)
}

pub async fn warm_cache(state: &ServerState) {
    let Some(app_router) = &state.app_router else {
        tracing::info!("[rari] Cache warmup: No app router available, skipping");
        return;
    };

    let paths = app_router.warmup_paths();

    if paths.is_empty() {
        tracing::info!("[rari] Cache warmup: No routes to warm");
        return;
    }

    tracing::info!("[rari] Cache warmup: Pre-rendering {} routes...", paths.len());
    let start = Instant::now();

    let success_count = Arc::new(AtomicUsize::new(0));
    let error_count = Arc::new(AtomicUsize::new(0));

    stream::iter(paths.iter())
        .for_each_concurrent(WARMUP_CONCURRENCY, |path| {
            let success_count = Arc::clone(&success_count);
            let error_count = Arc::clone(&error_count);
            async move {
                match warm_route(state, app_router, path).await {
                    Ok(()) => {
                        success_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) if is_warmup_interrupted(&e) => {
                        tracing::debug!(
                            "[rari] Cache warmup: interrupted while warming '{}': {}",
                            path,
                            e
                        );
                    }
                    Err(e) => {
                        tracing::error!("[rari] Cache warmup: Failed to warm '{}': {}", path, e);
                        error_count.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        })
        .await;

    let elapsed = start.elapsed();
    tracing::info!(
        "[rari] Cache warmup: Completed in {:.1}ms ({} succeeded, {} failed)",
        elapsed.as_secs_f64() * 1000.0,
        success_count.load(Ordering::Relaxed),
        error_count.load(Ordering::Relaxed),
    );
}

#[expect(clippy::too_many_lines)]
async fn warm_route(
    state: &ServerState,
    app_router: &Arc<AppRouter>,
    path: &str,
) -> Result<(), RariError> {
    let route_match = app_router.match_route(path)?;

    if route_match.loading.is_some() {
        return Ok(());
    }

    let mut context = create_warmup_context(&route_match);

    let layout_renderer = LayoutRenderer::with_shared_cache(
        Arc::clone(&state.renderer),
        Arc::clone(&state.layout_html_cache),
    );

    let request_context =
        Arc::new(RequestContext::new(route_match.route.path.clone()).without_layout_html_cache());

    let _render_guard = warmup_render_lock().await.lock_owned().await;

    context.metadata = collect_page_metadata(state, &route_match, &context).await;

    let render_result = layout_renderer
        .render_route_with_streaming(
            &route_match,
            &context,
            Some(Arc::clone(&request_context)),
            false,
            None,
        )
        .await
        .map_err(|error| wrap_warmup_render_error(&error))?;

    let html = match render_result {
        RenderResult::Static(html) => html,
        RenderResult::Chunked {
            content_type: ChunkedContentType::Html,
            shell,
            closing,
            mut chunks,
        } => match drain_chunked_stream(shell, closing, &mut chunks).await {
            Ok(html) => html,
            Err(error) => {
                tracing::warn!("Skipping cache warmup for {path}: chunked stream failed: {error}");
                return Ok(());
            }
        },
        _ => return Ok(()),
    };

    let html_cache_key = response::ResponseCache::generate_cache_key(path, None);
    let cache_control = state.config.get_cache_control_for_route(path);
    let cache_policy = response::RouteCachePolicy::from_cache_control(cache_control, path);
    let for_response_cache = cache_policy.enabled
        && state.response_cache.config.enabled
        && state.config.server.origin.is_some();

    let html = wrap_html_with_metadata(html, state);
    let etag = response::ResponseCache::generate_etag(html.as_bytes());

    let html_cache_entry = if for_response_cache {
        let merged_tags = super::merge_page_cache_tags(state, cache_policy.tags.clone()).await;
        let body_bytes = bytes::Bytes::from(html);

        let (compressed_gzip, compressed_zstd, compressed_br) =
            compress_all_encodings(body_bytes.clone()).await;

        let prebuilt = Arc::new(response::PrebuiltResponse {
            identity: body_bytes.clone(),
            gzip: compressed_gzip.clone(),
            br: compressed_br.clone(),
            zstd: compressed_zstd.clone(),
            etag: etag.clone(),
            content_type: "text/html; charset=utf-8".to_string(),
            cache_control: cache_control.to_string(),
            is_not_found: false,
            cached_at: Instant::now(),
            route: None,
        });

        Some(WarmupHtmlCacheEntry {
            path: path.to_string(),
            key: html_cache_key,
            prebuilt,
            response: response::CachedResponse {
                body: body_bytes,
                headers: HeaderMap::new(),
                metadata: response::CacheMetadata {
                    cached_at: Instant::now(),
                    ttl: cache_policy.ttl,
                    etag: Some(etag),
                    tags: merged_tags,
                },
                compressed_zstd,
                compressed_br,
                compressed_gzip,
            },
            max_entries: state.response_cache.config.max_entries,
        })
    } else {
        None
    };

    let rsc_result = layout_renderer
        .render_route(&route_match, &context, Some(Arc::clone(&request_context)))
        .await;

    let rsc_cache_entry = if for_response_cache {
        if let Ok(rsc_flight_protocol) = rsc_result {
            let rsc_cache_key = response::ResponseCache::generate_cache_key_with_mode(
                path,
                None,
                Some("rsc"),
                None,
            );
            let merged_tags = super::merge_page_cache_tags(state, cache_policy.tags.clone()).await;
            let mut cache_headers = HeaderMap::new();

            if let Some(ref metadata) = context.metadata
                && let Ok(metadata_json) = serde_json::to_string(metadata)
            {
                let encoded_metadata = urlencoding::encode(&metadata_json);
                if let Ok(header_value) = encoded_metadata.as_ref().parse() {
                    cache_headers.insert("x-rari-metadata", header_value);
                }
            }

            Some(WarmupResponseCacheEntry {
                key: rsc_cache_key,
                response: response::CachedResponse {
                    body: bytes::Bytes::from(rsc_flight_protocol),
                    headers: cache_headers,
                    metadata: response::CacheMetadata {
                        cached_at: Instant::now(),
                        ttl: cache_policy.ttl,
                        etag: None,
                        tags: merged_tags,
                    },
                    compressed_zstd: None,
                    compressed_br: None,
                    compressed_gzip: None,
                },
            })
        } else {
            None
        }
    } else {
        None
    };

    if let Some(html_cache_entry) = html_cache_entry {
        store_warmed_render(
            &state.static_fast_cache,
            &state.response_cache,
            &request_context,
            html_cache_entry,
            rsc_cache_entry,
        )
        .await;
    }

    Ok(())
}

async fn store_warmed_render(
    static_fast_cache: &response::StaticFastCache,
    response_cache: &response::ResponseCache,
    request_context: &RequestContext,
    html: WarmupHtmlCacheEntry,
    rsc: Option<WarmupResponseCacheEntry>,
) {
    if !request_context.response_cache_allowed() {
        return;
    }

    response_cache.set_for_request(html.key, html.response, request_context).await;
    if !request_context.response_cache_allowed() {
        return;
    }

    if let Some(rsc) = rsc {
        response_cache.set_for_request(rsc.key, rsc.response, request_context).await;
    }

    if request_context.response_cache_allowed() {
        response::insert_static_fast_cache(
            static_fast_cache,
            &html.path,
            html.prebuilt,
            html.max_entries,
        );
    }
}

fn create_warmup_context(route_match: &AppRouteMatch) -> LayoutRenderContext {
    let mut params: FxHashMap<String, ParamValue> = FxHashMap::default();

    for (key, value) in &route_match.params {
        params.insert(key.clone(), value.clone());
    }

    LayoutRenderContext {
        params,
        search_params: FxHashMap::default(),
        headers: FxHashMap::default(),
        pathname: route_match.pathname.clone(),
        template_navigation_id: None,
        metadata: None,
        reuse_layout_paths: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Instant};

    use axum::http::HeaderMap;
    use bytes::Bytes;

    use super::{WarmupHtmlCacheEntry, WarmupResponseCacheEntry, store_warmed_render};
    use crate::server::{
        cache::response::{
            CacheConfig, CacheMetadata, CachedResponse, PrebuiltResponse, ResponseCache,
            StaticFastCache,
        },
        middleware::request_context::RequestContext,
    };

    fn test_cached_response(body: &str) -> CachedResponse {
        CachedResponse {
            body: Bytes::from(body.to_string()),
            headers: HeaderMap::new(),
            metadata: CacheMetadata {
                cached_at: Instant::now(),
                ttl: 60,
                etag: None,
                tags: Vec::new(),
            },
            compressed_zstd: None,
            compressed_br: None,
            compressed_gzip: None,
        }
    }

    fn test_prebuilt_response() -> Arc<PrebuiltResponse> {
        Arc::new(PrebuiltResponse {
            identity: Bytes::from_static(b"warm html"),
            gzip: None,
            br: None,
            zstd: None,
            etag: "W/\"warm\"".to_string(),
            content_type: "text/html; charset=utf-8".to_string(),
            cache_control: "public, max-age=60".to_string(),
            is_not_found: false,
            cached_at: Instant::now(),
            route: None,
        })
    }

    #[tokio::test]
    async fn marked_warmup_render_skips_all_cache_writes() {
        let static_fast_cache = StaticFastCache::new();
        let response_cache = ResponseCache::new(CacheConfig::default());
        let request_context = RequestContext::new("/maintenance".to_string());
        request_context.mark_response_unavailable(17);

        store_warmed_render(
            &static_fast_cache,
            &response_cache,
            &request_context,
            WarmupHtmlCacheEntry {
                path: "/maintenance".to_string(),
                key: "html-key".to_string(),
                prebuilt: test_prebuilt_response(),
                response: test_cached_response("maintenance html"),
                max_entries: 10,
            },
            Some(WarmupResponseCacheEntry {
                key: "rsc-key".to_string(),
                response: test_cached_response("maintenance rsc"),
            }),
        )
        .await;

        assert!(!static_fast_cache.contains_key("/maintenance"));
        assert!(response_cache.get("html-key").await.is_none());
        assert!(response_cache.get("rsc-key").await.is_none());
    }
}

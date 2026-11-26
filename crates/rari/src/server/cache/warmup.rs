use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};

use axum::http::HeaderMap;
use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use rari_error::RariError;
use rustc_hash::FxHashMap;
use tokio::sync::{Mutex, OnceCell};

use crate::{
    rendering::layout::{
        ChunkedContentType, LayoutRenderContext, LayoutRenderer, PageData, drain_chunked_stream,
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
const ROUTE_ACTIVE: u64 = 1;
const ROUTE_PUBLISHING: u64 = 2;

#[derive(Default)]
pub(crate) struct WarmupGenerations {
    active: AtomicBool,
    routes: DashMap<String, Arc<AtomicU64>>,
    invalidation_generation: AtomicU64,
    invalidations_in_flight: AtomicUsize,
    publication_lock: Mutex<()>,
}

pub(crate) struct WarmupInvalidation<'a>(&'a WarmupGenerations);

impl Drop for WarmupInvalidation<'_> {
    fn drop(&mut self) {
        self.0.invalidation_generation.fetch_add(1, Ordering::AcqRel);
        self.0.invalidations_in_flight.fetch_sub(1, Ordering::Release);
    }
}

impl WarmupGenerations {
    pub(crate) fn new(paths: Vec<String>) -> Self {
        let routes: DashMap<_, _> =
            paths.into_iter().map(|path| (path, Arc::new(AtomicU64::new(0)))).collect();
        Self {
            active: AtomicBool::new(!routes.is_empty()),
            routes,
            invalidation_generation: AtomicU64::new(0),
            invalidations_in_flight: AtomicUsize::new(0),
            publication_lock: Mutex::new(()),
        }
    }

    fn route(&self, path: &str) -> Option<Arc<AtomicU64>> {
        if !self.active.load(Ordering::Acquire) {
            return None;
        }
        self.routes.get(path).map(|entry| Arc::clone(entry.value()))
    }

    /// Returns true when a request must bypass cache reads and writes while a
    /// warmup publication is in progress for this route.
    pub(crate) fn record_activity(&self, path: &str) -> bool {
        self.route(path).is_some_and(|generation| {
            generation.fetch_or(ROUTE_ACTIVE, Ordering::AcqRel) & ROUTE_PUBLISHING != 0
        })
    }

    pub(crate) async fn begin_invalidation(&self, path: &str) -> Option<WarmupInvalidation<'_>> {
        if !self.active.load(Ordering::Acquire) {
            return None;
        }
        self.invalidations_in_flight.fetch_add(1, Ordering::AcqRel);
        self.invalidation_generation.fetch_add(1, Ordering::AcqRel);
        let invalidation = WarmupInvalidation(self);

        // If a warmup publication already started, let it finish before the
        // invalidation removes its entries.
        drop(self.publication_lock.lock().await);
        self.record_activity(path);
        Some(invalidation)
    }

    pub(crate) fn finish(&self) {
        self.active.store(false, Ordering::Release);
        self.routes.clear();
    }
}

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

struct WarmupCacheEntries {
    html: WarmupHtmlCacheEntry,
    rsc: Option<WarmupResponseCacheEntry>,
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
    let Some(generation) = state.warmup_generations.route(path) else {
        return Ok(());
    };
    if state.warmup_generations.invalidations_in_flight.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    let initial_invalidations =
        state.warmup_generations.invalidation_generation.load(Ordering::Acquire);
    if state.warmup_generations.invalidations_in_flight.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    if generation.load(Ordering::Acquire) != 0 {
        return Ok(());
    }

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

    let mut has_page_data = true;
    if route_match.not_found.is_none() {
        match layout_renderer
            .get_page_data(&route_match, &context, Arc::clone(&request_context))
            .await
        {
            Ok(page_data) => match page_data {
                PageData::Missing => has_page_data = false,
                PageData::Failed(error) => {
                    request_context.disable_cache_writes();
                    tracing::error!(
                        "getData failed for route '{}': {}; skipping warmup cache writes",
                        route_match.route.path,
                        error,
                    );
                }
                PageData::NotFound => {
                    return Ok(());
                }
                PageData::Found(props) => context.page_data_props = props,
            },
            Err(error) => {
                request_context.disable_cache_writes();
                tracing::error!(
                    "Failed to get page data for route '{}': {}",
                    route_match.route.path,
                    error
                );
            }
        }
    }

    context.metadata =
        collect_page_metadata(state, &route_match, &context, Some(Arc::clone(&request_context)))
            .await;
    let request_data_check =
        response::request_data_check(&request_context, context.metadata.as_ref());

    if request_context.response_unavailable_after().is_some() {
        tracing::debug!("Skipping cache warmup for {path}: response marked unavailable");
        return Ok(());
    }

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
            has_page_data,
            has_dynamic_metadata: request_context.has_dynamic_metadata(),
            request_data_check: request_data_check.clone(),
            tags: merged_tags.clone(),
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
                    has_page_data,
                    has_dynamic_metadata: request_context.has_dynamic_metadata(),
                    request_data_check: request_data_check.clone(),
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
                        has_page_data,
                        has_dynamic_metadata: request_context.has_dynamic_metadata(),
                        request_data_check: request_data_check.clone(),
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
        publish_warmed_render(
            &state.warmup_generations,
            &generation,
            initial_invalidations,
            &state.static_fast_cache,
            &state.response_cache,
            &request_context,
            WarmupCacheEntries { html: html_cache_entry, rsc: rsc_cache_entry },
        )
        .await;
    }

    Ok(())
}

async fn publish_warmed_render(
    generations: &WarmupGenerations,
    generation: &AtomicU64,
    initial_invalidations: u64,
    static_fast_cache: &response::StaticFastCache,
    response_cache: &response::ResponseCache,
    request_context: &RequestContext,
    entries: WarmupCacheEntries,
) {
    // An invalidated tag can affect another route. Do not publish across an
    // invalidation, and let invalidations wait for any ongoing publication.
    let publication = generations.publication_lock.lock().await;
    if generations.invalidations_in_flight.load(Ordering::Acquire) != 0
        || generations.invalidation_generation.load(Ordering::Acquire) != initial_invalidations
    {
        return;
    }
    if generation
        .compare_exchange(0, ROUTE_PUBLISHING, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let path = entries.html.path.clone();
    let html_key = entries.html.key.clone();
    let rsc_key = entries.rsc.as_ref().map(|entry| entry.key.clone());
    store_warmed_render(
        static_fast_cache,
        response_cache,
        request_context,
        entries.html,
        entries.rsc,
    )
    .await;
    if generation
        .compare_exchange(ROUTE_PUBLISHING, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        // Requests that arrived during publication bypassed the caches. Remove
        // the partial warmup entries before allowing later requests to use them.
        response_cache.invalidate(&html_key).await;
        if let Some(rsc_key) = rsc_key {
            response_cache.invalidate(&rsc_key).await;
        }
        response::invalidate_static_fast_cache_for_path(static_fast_cache, &path);
        generation.fetch_and(!ROUTE_PUBLISHING, Ordering::Release);
    }
    drop(publication);
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
        page_data_props: None,
        template_navigation_id: None,
        metadata: None,
        reuse_layout_paths: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    use axum::{
        extract::{Query, State},
        http::{HeaderMap, StatusCode},
    };
    use bytes::Bytes;
    use rustc_hash::FxHashMap;
    use tokio::{
        sync::{Mutex, Notify},
        time::timeout,
    };

    use super::{
        WarmupCacheEntries, WarmupGenerations, WarmupHtmlCacheEntry, WarmupResponseCacheEntry,
        publish_warmed_render, store_warmed_render,
    };
    use crate::{
        RscHtmlRenderer, RscRenderer,
        rendering::layout::LayoutHtmlCache,
        runtime::JsExecutionRuntime,
        server::{
            FallbackHtmlCache, ServerState,
            cache::{
                handler::{
                    CacheError, CacheHandler, CacheHandlerRegistry, MemoryCacheHandler, SetOutcome,
                    async_trait,
                },
                response::{
                    CacheConfig, CacheMetadata, CachedResponse, PrebuiltResponse, RequestDataCheck,
                    ResponseCache, StaticFastCache, insert_static_fast_cache,
                },
            },
            config::{Config, Mode},
            middleware::request_context::RequestContext,
            routing::app::handle_app_route,
        },
    };

    #[derive(Debug, Default)]
    struct DelayedCacheHandler {
        inner: MemoryCacheHandler,
        started: Notify,
        release: Notify,
        sets: AtomicUsize,
    }

    #[async_trait]
    impl CacheHandler for DelayedCacheHandler {
        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CacheError> {
            self.inner.get(key).await
        }

        async fn set(&self, key: &str, value: Vec<u8>, ttl: u64) -> Result<SetOutcome, CacheError> {
            self.set_with_tags(key, value, ttl, &[]).await
        }

        async fn set_with_tags(
            &self,
            key: &str,
            value: Vec<u8>,
            ttl: u64,
            tags: &[String],
        ) -> Result<SetOutcome, CacheError> {
            if self.sets.fetch_add(1, Ordering::Relaxed) == 0 {
                self.started.notify_one();
                self.release.notified().await;
            }
            self.inner.set_with_tags(key, value, ttl, tags).await
        }

        async fn invalidate(&self, key: &str) -> Result<bool, CacheError> {
            self.inner.invalidate(key).await
        }

        async fn invalidate_by_tag(&self, tag: &str) -> Result<(), CacheError> {
            self.inner.invalidate_by_tag(tag).await
        }

        async fn clear(&self) -> Result<(), CacheError> {
            self.inner.clear().await
        }

        fn get_all_keys(&self) -> Vec<String> {
            self.inner.get_all_keys()
        }
    }

    fn test_cached_response(body: &str) -> CachedResponse {
        CachedResponse {
            body: Bytes::from(body.to_string()),
            headers: HeaderMap::new(),
            metadata: CacheMetadata {
                cached_at: Instant::now(),
                ttl: 60,
                etag: None,
                tags: Vec::new(),
                has_page_data: true,
                has_dynamic_metadata: true,
                request_data_check: RequestDataCheck::NotRequired,
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
            has_page_data: false,
            has_dynamic_metadata: false,
            request_data_check: RequestDataCheck::NotRequired,
            tags: Vec::new(),
            cached_at: Instant::now(),
            route: None,
        })
    }

    fn test_server_state(
        generations: Arc<WarmupGenerations>,
        fast_cache: Arc<StaticFastCache>,
        response_cache: Arc<ResponseCache>,
    ) -> ServerState {
        let runtime = Arc::new(JsExecutionRuntime::new(None));
        ServerState {
            renderer: Arc::new(Mutex::new(RscRenderer::new(Arc::clone(&runtime)))),
            ssr_renderer: Arc::new(RscHtmlRenderer::new(Arc::clone(&runtime))),
            js_runtime: runtime,
            config: Arc::new(Config::new(Mode::Production)),
            app_router: None,
            api_route_handler: None,
            html_cache: FallbackHtmlCache::default(),
            layout_html_cache: Arc::new(LayoutHtmlCache::new()),
            response_cache,
            static_fast_cache: fast_cache,
            warmup_generations: generations,
            og_generator: None,
            app_icons: Arc::new(Vec::new()),
            project_root: PathBuf::from("."),
            image_optimizer: None,
            cache_registry: Arc::new(CacheHandlerRegistry::default_with_memory()),
            image_handler: Arc::new(MemoryCacheHandler::default()),
        }
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

    #[tokio::test]
    #[expect(clippy::expect_used, reason = "test setup and assertions must succeed")]
    async fn request_during_delayed_warmup_publication_does_not_wait_or_see_stale_entries() {
        let generations = Arc::new(WarmupGenerations::new(vec!["/slow".to_string()]));
        let generation = generations.route("/slow").expect("warmup route");
        let handler = Arc::new(DelayedCacheHandler::default());
        let response_cache = Arc::new(ResponseCache::new_with_handler(
            CacheConfig::default(),
            Arc::<DelayedCacheHandler>::clone(&handler),
        ));
        let fast_cache = Arc::new(StaticFastCache::new());
        insert_static_fast_cache(&fast_cache, "/slow", test_prebuilt_response(), 10);
        let state = test_server_state(
            Arc::clone(&generations),
            Arc::clone(&fast_cache),
            Arc::clone(&response_cache),
        );
        let task_generations = Arc::clone(&generations);
        let task_response_cache = Arc::clone(&response_cache);
        let task_fast_cache = Arc::clone(&fast_cache);
        let task = tokio::spawn(async move {
            let context = RequestContext::new("/slow".to_string());
            publish_warmed_render(
                &task_generations,
                &generation,
                0,
                &task_fast_cache,
                &task_response_cache,
                &context,
                WarmupCacheEntries {
                    html: WarmupHtmlCacheEntry {
                        path: "/slow".to_string(),
                        key: "html-key".to_string(),
                        prebuilt: test_prebuilt_response(),
                        response: test_cached_response("old html"),
                        max_entries: 10,
                    },
                    rsc: Some(WarmupResponseCacheEntry {
                        key: "rsc-key".to_string(),
                        response: test_cached_response("old rsc"),
                    }),
                },
            )
            .await;
        });

        timeout(Duration::from_secs(2), handler.started.notified())
            .await
            .expect("warmup publication started");
        let request = timeout(
            Duration::from_secs(2),
            handle_app_route(
                State(state),
                "/slow".parse().expect("valid URI"),
                Query(FxHashMap::default()),
                HeaderMap::new(),
            ),
        )
        .await;
        handler.release.notify_one();
        task.await.expect("warmup task");

        assert!(matches!(
            request.expect("request waited for warmup publication"),
            Err(StatusCode::NOT_FOUND)
        ));
        assert!(response_cache.get("html-key").await.is_none());
        assert!(response_cache.get("rsc-key").await.is_none());
        assert!(!fast_cache.contains_key("/slow"));
    }
}

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

pub mod request;

use crate::rsc::rendering::layout::LayoutHtmlCache;
use crate::server::cache::response;
use crate::server::config;
use crate::server::og::OgImageGenerator;
use crate::server::routing;

/// Capacity of the SPA fallback shell cache (`ServerState::html_cache`).
pub const FALLBACK_HTML_CACHE_CAPACITY: std::num::NonZeroUsize =
    std::num::NonZeroUsize::new(256).expect("FALLBACK_HTML_CACHE_CAPACITY must be non-zero");

#[derive(Clone)]
pub struct ServerState {
    pub renderer: Arc<tokio::sync::Mutex<crate::rsc::RscRenderer>>,
    pub ssr_renderer: Arc<crate::rsc::RscHtmlRenderer>,
    pub config: Arc<config::Config>,
    pub request_count: Arc<std::sync::atomic::AtomicU64>,
    pub start_time: std::time::Instant,
    pub component_cache_configs:
        Arc<tokio::sync::RwLock<FxHashMap<String, FxHashMap<String, String>>>>,
    pub page_cache_configs: Arc<tokio::sync::RwLock<FxHashMap<String, FxHashMap<String, String>>>>,
    pub app_router: Option<Arc<routing::AppRouter>>,
    pub api_route_handler: Option<Arc<routing::ApiRouteHandler>>,
    pub module_reload_manager: Arc<crate::runtime::module::reload::ModuleReloadManager>,
    // Entry-capped LRU of the SPA fallback shell, keyed by request path, so it can't
    // grow unbounded with distinct paths. In production the value is path-independent
    // (always index.html), so this mainly avoids repeated disk reads.
    pub html_cache: Arc<parking_lot::Mutex<lru::LruCache<String, String>>>,
    pub layout_html_cache: Arc<LayoutHtmlCache>,
    pub response_cache: Arc<response::ResponseCache>,
    pub og_generator: Option<Arc<OgImageGenerator>>,
    pub project_root: PathBuf,
    pub image_optimizer: Option<Arc<crate::server::image::ImageOptimizer>>,
}

#[derive(Debug, Deserialize)]
pub struct RenderRequest {
    pub component_id: String,
    pub props: Option<Value>,
    pub ssr: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct RenderResponse {
    pub success: bool,
    pub data: Option<String>,
    pub error: Option<String>,
    pub component_id: String,
    pub render_time_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub component_id: String,
    pub component_code: String,
    pub cache_config: Option<FxHashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterClientRequest {
    pub component_id: String,
    pub file_path: String,
    pub export_name: String,
}

#[derive(Debug, Deserialize)]
pub struct HmrRegisterRequest {
    pub file_path: String,
}

#[derive(Debug, Deserialize)]
pub struct ReloadComponentRequest {
    pub component_id: String,
    pub bundle_path: String,
}

#[derive(Debug, Serialize)]
pub struct ReloadComponentResponse {
    pub success: bool,
    pub message: String,
}

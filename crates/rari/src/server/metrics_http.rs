//! Per-route SSR request duration histogram, exposed via /_rari/metrics.
//! Labelled by the matched route PATTERN (e.g. "/news/[slug]"), never the raw
//! URL, so label cardinality stays bounded by the app's route table.

use dashmap::DashMap;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Upper bounds in seconds for each histogram bucket (plus an implicit +Inf).
const BUCKETS: [f64; 10] = [0.005, 0.025, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

#[derive(Default)]
struct RouteHist {
    buckets: [AtomicU64; BUCKETS.len() + 1],
    sum_micros: AtomicU64,
    count: AtomicU64,
}

static HISTOGRAMS: LazyLock<DashMap<String, RouteHist>> = LazyLock::new(DashMap::new);

fn record(route: &str, seconds: f64) {
    let hist = HISTOGRAMS.entry(route.to_string()).or_default();
    let idx = BUCKETS.iter().position(|b| seconds <= *b).unwrap_or(BUCKETS.len());
    hist.buckets[idx].fetch_add(1, Ordering::Relaxed);
    hist.sum_micros.fetch_add((seconds * 1e6) as u64, Ordering::Relaxed);
    hist.count.fetch_add(1, Ordering::Relaxed);
}

/// Records the request duration on drop, so every exit path of the handler —
/// including `?` early returns — is counted.
pub struct RequestTimer {
    route: String,
    start: Instant,
}

impl RequestTimer {
    pub fn start(route: &str) -> Self {
        Self { route: route.to_string(), start: Instant::now() }
    }
}

impl Drop for RequestTimer {
    fn drop(&mut self) {
        record(&self.route, self.start.elapsed().as_secs_f64());
    }
}

/// Renders all histograms in Prometheus text format.
pub fn render_prometheus(out: &mut String) {
    if HISTOGRAMS.is_empty() {
        return;
    }
    out.push_str("# TYPE rari_ssr_request_duration_seconds histogram\n");
    for entry in HISTOGRAMS.iter() {
        let route = entry.key();
        let h = entry.value();
        let mut cumulative = 0u64;
        for (i, le) in BUCKETS.iter().enumerate() {
            cumulative += h.buckets[i].load(Ordering::Relaxed);
            out.push_str(&format!(
                "rari_ssr_request_duration_seconds_bucket{{route=\"{route}\",le=\"{le}\"}} {cumulative}\n"
            ));
        }
        cumulative += h.buckets[BUCKETS.len()].load(Ordering::Relaxed);
        out.push_str(&format!(
            "rari_ssr_request_duration_seconds_bucket{{route=\"{route}\",le=\"+Inf\"}} {cumulative}\n"
        ));
        out.push_str(&format!(
            "rari_ssr_request_duration_seconds_sum{{route=\"{route}\"}} {}\n",
            h.sum_micros.load(Ordering::Relaxed) as f64 / 1e6
        ));
        out.push_str(&format!(
            "rari_ssr_request_duration_seconds_count{{route=\"{route}\"}} {}\n",
            h.count.load(Ordering::Relaxed)
        ));
    }
}

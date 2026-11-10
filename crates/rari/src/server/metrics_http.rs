use std::{
    fmt::Write as _,
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use dashmap::DashMap;

const BUCKETS: [f64; 10] = [0.005, 0.025, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

#[derive(Default)]
struct RouteHistogram {
    buckets: [AtomicU64; BUCKETS.len() + 1],
    sum_micros: AtomicU64,
    count: AtomicU64,
}

static HISTOGRAMS: LazyLock<DashMap<String, RouteHistogram>> = LazyLock::new(DashMap::new);

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
        record(&self.route, self.start.elapsed());
    }
}

pub fn route_label(route: &str, is_not_found: bool) -> &str {
    if is_not_found { "__not_found__" } else { route }
}

fn record(route: &str, elapsed: Duration) {
    let histogram = HISTOGRAMS.entry(route.to_string()).or_default();
    let seconds = elapsed.as_secs_f64();
    let bucket = BUCKETS.iter().position(|bound| seconds <= *bound).unwrap_or(BUCKETS.len());
    histogram.buckets[bucket].fetch_add(1, Ordering::Relaxed);
    histogram
        .sum_micros
        .fetch_add(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX), Ordering::Relaxed);
    histogram.count.fetch_add(1, Ordering::Relaxed);
}

pub fn render_prometheus(output: &mut String) {
    if HISTOGRAMS.is_empty() {
        return;
    }

    output.push_str("# TYPE rari_ssr_request_duration_seconds histogram\n");
    for entry in HISTOGRAMS.iter() {
        let route = escape_label(entry.key());
        let histogram = entry.value();
        let mut cumulative = 0u64;
        for (index, bound) in BUCKETS.iter().enumerate() {
            cumulative += histogram.buckets[index].load(Ordering::Relaxed);
            let _ = writeln!(
                output,
                "rari_ssr_request_duration_seconds_bucket{{route=\"{route}\",le=\"{bound}\"}} {cumulative}"
            );
        }
        cumulative += histogram.buckets[BUCKETS.len()].load(Ordering::Relaxed);
        let _ = writeln!(
            output,
            "rari_ssr_request_duration_seconds_bucket{{route=\"{route}\",le=\"+Inf\"}} {cumulative}"
        );
        #[expect(clippy::cast_precision_loss, reason = "Prometheus histogram sums are seconds")]
        let sum_seconds = histogram.sum_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0;
        let _ = writeln!(
            output,
            "rari_ssr_request_duration_seconds_sum{{route=\"{route}\"}} {sum_seconds}"
        );
        let _ = writeln!(
            output,
            "rari_ssr_request_duration_seconds_count{{route=\"{route}\"}} {}",
            histogram.count.load(Ordering::Relaxed)
        );
    }
}

fn escape_label(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_routes_share_one_bounded_label() {
        assert_eq!(route_label("/random-crawler-path", true), "__not_found__");
        assert_eq!(route_label("/news/[slug]", false), "/news/[slug]");
    }

    #[test]
    fn timer_exports_a_cumulative_prometheus_histogram() {
        let route = "/metrics-http-test";
        drop(RequestTimer::start(route));

        let mut output = String::new();
        render_prometheus(&mut output);

        assert!(output.contains("# TYPE rari_ssr_request_duration_seconds histogram"));
        assert!(output.contains(
            "rari_ssr_request_duration_seconds_bucket{route=\"/metrics-http-test\",le=\"+Inf\"} 1"
        ));
        assert!(
            output.contains(
                "rari_ssr_request_duration_seconds_count{route=\"/metrics-http-test\"} 1"
            )
        );
    }

    #[test]
    fn label_values_are_escaped_for_prometheus() {
        assert_eq!(escape_label("/route\"name\\segment\n"), "/route\\\"name\\\\segment\\n");
    }
}

//! `monitoring/productionLogSummary.ts`: in production the console only gets errors,
//! plus one `http:summary` line per 30 s window.

use indexmap::IndexMap;
use parking_lot::Mutex;
use std::sync::OnceLock;

pub const WINDOW_MS: i64 = 30_000;
/// The tracing target the production filter lets through at info.
pub const TARGET: &str = "happy_server_rs::summary";

#[derive(Default)]
struct RouteStats {
    requests: u64,
    errors: u64,
    total_ms: f64,
    max_ms: f64,
}

#[derive(Default)]
struct Window {
    started_at: i64,
    requests: u64,
    s2xx: u64,
    s4xx: u64,
    s5xx: u64,
    errors: u64,
    slow: u64,
    total_ms: f64,
    max_ms: f64,
    durations: Vec<f64>,
    routes: IndexMap<String, RouteStats>,
}

static WINDOW: OnceLock<Mutex<Window>> = OnceLock::new();

/// Starts recording (production only); the caller flushes every [`WINDOW_MS`].
pub fn enable() {
    let _ = WINDOW.set(Mutex::new(Window { started_at: crate::util::now_ms(), ..Default::default() }));
}

pub fn record_request(method: &str, route: &str, status: u16, ms: f64) {
    let Some(w) = WINDOW.get() else { return };
    if route == "/health" && status < 500 {
        return;
    }
    let mut w = w.lock();
    w.requests += 1;
    match status {
        500.. => w.s5xx += 1,
        400.. => w.s4xx += 1,
        200.. => w.s2xx += 1,
        _ => {}
    }
    w.total_ms += ms;
    w.max_ms = w.max_ms.max(ms);
    w.durations.push(ms);
    if ms >= 1000.0 {
        w.slow += 1;
    }
    let r = w.routes.entry(format!("{} {}", method, route)).or_default();
    r.requests += 1;
    if status >= 500 {
        r.errors += 1;
    }
    r.total_ms += ms;
    r.max_ms = r.max_ms.max(ms);
}

/// An error that reached the error handler.
pub fn record_error() {
    if let Some(w) = WINDOW.get() {
        w.lock().errors += 1;
    }
}

fn round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// The summary line for the window just ended, if anything happened in it.
pub fn flush(now: i64) -> Option<String> {
    let w = WINDOW.get()?;
    let w = std::mem::replace(&mut *w.lock(), Window { started_at: now, ..Default::default() });
    if w.requests == 0 && w.errors == 0 {
        return None;
    }
    let elapsed = round((now - w.started_at) as f64 / 1000.0).max(1);
    let avg = if w.requests > 0 { w.total_ms / w.requests as f64 } else { 0.0 };
    let mut durations = w.durations;
    durations.sort_by(|a, b| a.total_cmp(b));
    let p95 = if durations.is_empty() { 0.0 } else { durations[((durations.len() as f64 * 0.95).ceil() as usize).max(1) - 1] };
    let mut routes: Vec<(String, RouteStats)> = w.routes.into_iter().collect();
    routes.sort_by(|a, b| b.1.requests.cmp(&a.1.requests)); // stable, like Array.sort
    let top: Vec<String> =
        routes.iter().take(3).map(|(k, r)| format!("{}:{}req/{}err/{}ms", k, r.requests, r.errors, round(r.total_ms / r.requests as f64))).collect();
    let mut parts = vec![
        "http:summary".to_string(),
        format!("window={}s", elapsed),
        format!("requests={}", w.requests),
        format!("2xx={}", w.s2xx),
        format!("4xx={}", w.s4xx),
        format!("5xx={}", w.s5xx),
        format!("errors={}", w.errors),
        // Prisma interactive-transaction timeouts; sqlx transactions have none.
        "txTimeouts=0".to_string(),
        format!("slow1s={}", w.slow),
        format!("avg={}ms", round(avg)),
        format!("p95={}ms", round(p95)),
        format!("max={}ms", round(w.max_ms)),
    ];
    if !top.is_empty() {
        parts.push(format!("top={}", top.join(",")));
    }
    Some(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_line() {
        enable();
        let t0 = WINDOW.get().unwrap().lock().started_at;
        record_request("GET", "/health", 200, 1.0); // not counted
        record_request("GET", "/v1/sessions", 200, 3.0);
        record_request("GET", "/v1/sessions", 500, 1200.0);
        record_request("POST", "/v1/auth", 401, 2.0);
        record_error();
        let line = flush(t0 + 29_600).unwrap();
        assert_eq!(
            line,
            "http:summary window=30s requests=3 2xx=1 4xx=1 5xx=1 errors=1 txTimeouts=0 slow1s=1 avg=402ms p95=1200ms max=1200ms \
             top=GET /v1/sessions:2req/1err/602ms,POST /v1/auth:1req/0err/2ms"
        );
        assert_eq!(flush(t0 + 60_000), None);
    }
}

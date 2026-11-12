//! prom-client metrics (`metrics2.ts`), same names, labels and buckets.

use prometheus::{CounterVec, Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec, IntCounter, IntCounterVec, IntGauge, Opts, Registry, TextEncoder};
use std::collections::HashMap;

pub struct Metrics {
    pub registry: Registry,
    pub websocket_connections: GaugeVec,
    pub session_alive_events: IntCounter,
    pub machine_alive_events: IntCounter,
    pub session_cache: CounterVec,
    pub database_updates_skipped: CounterVec,
    pub websocket_events: CounterVec,
    pub http_requests: CounterVec,
    pub http_duration: HistogramVec,
    pub database_records: GaugeVec,
    pub rpc_calls: CounterVec,
    pub rpc_duration: HistogramVec,
    pub rpc_lookup_retries: HistogramVec,
    pub rpc_fetch_timeouts: CounterVec,
    /// Not in the TS server: log lines the non-blocking writer had to drop.
    pub log_lines_dropped: IntCounter,
    /// Not in the TS server: items (socket messages, v3 requests) per group-commit batch.
    pub message_batch_size: Histogram,
    /// Not in the TS server: history offload (`history.rs`).
    pub history_pages: IntCounterVec,
    pub history_bytes: IntCounter,
    pub history_backlog: IntGauge,
    pub history_storage_errors: IntCounterVec,
    pub history_shadow: IntCounterVec,
    pub history_verifier: IntCounterVec,
    pub history_sessions_blocked: IntGauge,
    pub history_rows_deleted: IntCounter,
    /// prom-client prints HELP/TYPE for a labelled metric before its first
    /// series; the prometheus crate leaves the family out.
    families: Vec<(String, String, &'static str)>,
}

/// `parseClientLabels`.
pub fn client_labels(raw: Option<&str>) -> (String, String) {
    match raw {
        Some(r) if !r.is_empty() => (r.to_string(), r.split('/').next().unwrap_or("").to_lowercase()),
        _ => ("unknown".into(), "unknown".into()),
    }
}

impl Metrics {
    pub fn new() -> Metrics {
        let mut labels = HashMap::new();
        labels.insert("app".to_string(), "happy-server".to_string());
        let registry = Registry::new_custom(None, Some(labels)).expect("registry");
        let websocket_connections =
            GaugeVec::new(Opts::new("websocket_connections_total", "Number of active WebSocket connections"), &["type", "client", "client_type"]).unwrap();
        let session_alive_events = IntCounter::new("session_alive_events_total", "Total number of session-alive events").unwrap();
        let machine_alive_events = IntCounter::new("machine_alive_events_total", "Total number of machine-alive events").unwrap();
        let session_cache = CounterVec::new(Opts::new("session_cache_operations_total", "Total session cache operations"), &["operation", "result"]).unwrap();
        let database_updates_skipped =
            CounterVec::new(Opts::new("database_updates_skipped_total", "Number of database updates skipped due to debouncing"), &["type"]).unwrap();
        let websocket_events =
            CounterVec::new(Opts::new("websocket_events_total", "Total WebSocket events received by type"), &["event_type", "client", "client_type"]).unwrap();
        let http_requests =
            CounterVec::new(Opts::new("http_requests_total", "Total number of HTTP requests"), &["method", "route", "status", "client", "client_type"]).unwrap();
        let http_duration = HistogramVec::new(
            HistogramOpts::new("http_request_duration_seconds", "HTTP request duration in seconds").buckets(vec![0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0]),
            &["method", "route", "status", "client", "client_type"],
        )
        .unwrap();
        let database_records = GaugeVec::new(Opts::new("database_records_total", "Total number of records in database tables"), &["table"]).unwrap();
        let rpc_calls = CounterVec::new(Opts::new("rpc_calls_total", "Total RPC calls by method and outcome"), &["method", "result"]).unwrap();
        let rpc_duration = HistogramVec::new(
            HistogramOpts::new("rpc_call_duration_seconds", "RPC call duration from receipt to response").buckets(vec![0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0, 30.0]),
            &["method", "result"],
        )
        .unwrap();
        let rpc_lookup_retries = HistogramVec::new(
            HistogramOpts::new("rpc_lookup_retries", "Number of grace-window polls before finding daemon (0 = instant)").buckets(vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]),
            &["method"],
        )
        .unwrap();
        let rpc_fetch_timeouts = CounterVec::new(Opts::new("rpc_fetchsockets_timeouts_total", "Cross-replica fetchSockets timeouts by context"), &["context"]).unwrap();
        let message_batch_size = Histogram::with_opts(
            HistogramOpts::new("message_write_batch_size", "Socket messages and v3 message requests written per group-commit batch")
                .buckets(vec![1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0]),
        )
        .unwrap();
        let history_pages = IntCounterVec::new(Opts::new("history_pages_total", "History pages by outcome (written, verified, offloaded, bad)"), &["state"]).unwrap();
        let history_bytes = IntCounter::new("history_offloaded_bytes_total", "Compressed bytes of history pages written to object storage").unwrap();
        let history_backlog = IntGauge::new("history_offload_backlog_rows", "Messages older than the retention window not yet in a page (last sweep)").unwrap();
        let history_storage_errors =
            IntCounterVec::new(Opts::new("history_storage_errors_total", "History page object storage errors by operation"), &["op"]).unwrap();
        let history_shadow = IntCounterVec::new(Opts::new("history_shadow_reads_total", "Shadow comparisons of served messages with history pages"), &["result"]).unwrap();
        let history_verifier = IntCounterVec::new(Opts::new("history_verifier_checks_total", "Sampled re-checks of verified history pages"), &["result"]).unwrap();
        let history_sessions_blocked = IntGauge::new("history_sessions_blocked", "Sessions whose history offload stopped at a bad page").unwrap();
        let history_rows_deleted = IntCounter::new("history_rows_deleted_total", "Message rows deleted from Postgres after their page was verified (retain)").unwrap();
        let log_lines_dropped = IntCounter::new("log_lines_dropped_total", "Log lines dropped because stdout could not keep up").unwrap();
        // No Redis stream here: the lag is always 0 (exported so dashboards and alerts keep working).
        let redis_stream_lag = Gauge::new("redis_stream_lag_ms", "Milliseconds between this pod read cursor and stream HEAD").unwrap();
        let collectors = [
            Box::new(websocket_connections.clone()) as Box<dyn prometheus::core::Collector>,
            Box::new(session_alive_events.clone()),
            Box::new(machine_alive_events.clone()),
            Box::new(session_cache.clone()),
            Box::new(database_updates_skipped.clone()),
            Box::new(websocket_events.clone()),
            Box::new(http_requests.clone()),
            Box::new(http_duration.clone()),
            Box::new(database_records.clone()),
            Box::new(rpc_calls.clone()),
            Box::new(rpc_duration.clone()),
            Box::new(rpc_lookup_retries.clone()),
            Box::new(rpc_fetch_timeouts.clone()),
            Box::new(log_lines_dropped.clone()),
            Box::new(message_batch_size.clone()),
            Box::new(history_pages.clone()),
            Box::new(history_bytes.clone()),
            Box::new(history_backlog.clone()),
            Box::new(history_storage_errors.clone()),
            Box::new(history_shadow.clone()),
            Box::new(history_verifier.clone()),
            Box::new(history_sessions_blocked.clone()),
            Box::new(history_rows_deleted.clone()),
            Box::new(redis_stream_lag),
        ];
        let mut families = Vec::new();
        for c in collectors {
            for d in c.desc() {
                let kind = match c.collect().first().map(|m| m.get_field_type()) {
                    Some(prometheus::proto::MetricType::COUNTER) => "counter",
                    Some(prometheus::proto::MetricType::HISTOGRAM) => "histogram",
                    _ => "gauge",
                };
                families.push((d.fq_name.clone(), d.help.clone(), kind));
            }
            registry.register(c).unwrap();
        }
        Metrics {
            registry,
            websocket_connections,
            session_alive_events,
            machine_alive_events,
            session_cache,
            database_updates_skipped,
            websocket_events,
            http_requests,
            http_duration,
            database_records,
            rpc_calls,
            rpc_duration,
            rpc_lookup_retries,
            rpc_fetch_timeouts,
            log_lines_dropped,
            message_batch_size,
            history_pages,
            history_bytes,
            history_backlog,
            history_storage_errors,
            history_shadow,
            history_verifier,
            history_sessions_blocked,
            history_rows_deleted,
            families,
        }
    }

    pub fn observe_http(&self, method: &str, route: &str, status: u16, client: Option<&str>, secs: f64) {
        let (client, client_type) = client_labels(client);
        let status = status.to_string();
        let labels = [method, route, status.as_str(), client.as_str(), client_type.as_str()];
        self.http_requests.with_label_values(&labels).inc();
        self.http_duration.with_label_values(&labels).observe(secs);
    }

    pub fn render(&self) -> String {
        let dropped = crate::logwriter::dropped_total();
        if dropped > self.log_lines_dropped.get() {
            self.log_lines_dropped.inc_by(dropped - self.log_lines_dropped.get());
        }
        let gathered = self.registry.gather();
        let mut buf = Vec::new();
        TextEncoder::new().encode(&gathered, &mut buf).ok();
        let mut out = String::from_utf8(buf).unwrap_or_default();
        for (name, help, kind) in &self.families {
            if !gathered.iter().any(|f| f.name() == name) {
                out.push_str(&format!("# HELP {} {}\n# TYPE {} {}\n", name, help, name, kind));
            }
        }
        out
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

//! happy-server-rs: wire-compatible Rust port of packages/happy-server.
//!
//! `happy-server-rs [serve]` runs the server; `happy-server-rs migrate` applies the
//! TS server's Prisma migrations to an empty database.

// Builders and helpers for the socket and Phase 3 routes are not all wired yet.
#![allow(dead_code)]

mod activity;
mod app;
mod auth;
mod config;
mod db;
mod engine;
mod events;
mod fetch;
mod handlers;
mod http;
mod js;
mod logwriter;
mod metrics;
mod models;
mod presence;
mod routes;
mod rpc;
mod sio;
mod summary;
mod socket;
mod storage;
mod util;
mod zod;

use app::App;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpSocket};

fn main() -> anyhow::Result<()> {
    let log = logwriter::stdout();
    tracing_subscriber::fmt()
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("HAPPY_LOG").unwrap_or_else(|_| default_log_filter().into()))
        .with_writer(log.clone())
        .init();
    let result = run();
    log.drain(Duration::from_secs(2));
    result
}

/// The TS levels: production consoles get errors plus the 30 s summary; elsewhere,
/// or with remote debug logging on, everything from debug up.
fn default_log_filter() -> String {
    let production = std::env::var("NODE_ENV").is_ok_and(|v| v == "production");
    let remote_debug = std::env::var("DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING").is_ok_and(|v| !v.is_empty());
    if production && !remote_debug {
        format!("error,{}=info", summary::TARGET)
    } else {
        "info,happy_server_rs=debug,sqlx=warn".into()
    }
}

fn run() -> anyhow::Result<()> {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    let config = config::Config::from_env()?;
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(config.workers).enable_all().build()?;
    match cmd.as_str() {
        "serve" => rt.block_on(serve(config)),
        "migrate" => rt.block_on(async {
            let pool = db::connect(&config.database_url, 2).await?;
            let n = db::migrate_prisma(&pool).await?;
            tracing::info!("applied {} migration(s)", n);
            Ok(())
        }),
        other => anyhow::bail!("unknown command {:?} (expected serve or migrate)", other),
    }
}

async fn serve(config: config::Config) -> anyhow::Result<()> {
    tracing::info!(workers = config.workers, db_pool = config.db_pool_size, "Starting happy-server-rs");
    // Single writer per database: the in-memory locks, presence and RPC routing
    // assume one process. Held until exit.
    let _instance_lock = db::acquire_instance_lock(&config.database_url).await?;
    let pool = db::connect(&config.database_url, config.db_pool_size).await?;
    let app = Arc::new(App::new(config, pool));
    app.files.load().await?;

    spawn_background(&app);

    let addr: SocketAddr = format!("{}:{}", app.config.host, app.config.port).parse()?;
    // Node's listen backlog (511); mio's bind uses std's 128, which overflows under a
    // burst of connects and costs each dropped SYN a 1 s retransmit.
    let socket = if addr.is_ipv4() { TcpSocket::new_v4()? } else { TcpSocket::new_v6()? };
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    let listener = socket.listen(511)?;
    tracing::info!("API ready on http://{}:{}", app.config.host, app.config.port);
    if app.config.metrics_enabled {
        let a = app.clone();
        tokio::spawn(async move {
            if let Err(e) = metrics_server(a).await {
                tracing::warn!(module = "metrics", "Metrics server not started: {}", e);
            }
        });
    } else {
        tracing::info!(module = "metrics", "Metrics server disabled");
    }

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(x) => x,
                    Err(e) => {
                        tracing::warn!("accept failed: {}", e);
                        continue;
                    }
                };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                tokio::spawn(async move {
                    let io = hyper_util::rt::TokioIo::new(stream);
                    let svc = hyper::service::service_fn(move |req| {
                        let app = app.clone();
                        async move { http::serve(app, req).await }
                    });
                    let _ = hyper::server::conn::http1::Builder::new().keep_alive(true).serve_connection(io, svc).with_upgrades().await;
                });
            }
            _ = &mut shutdown => break,
        }
    }
    tracing::info!("Shutting down...");
    app.engine.shutdown();
    app.activity.flush().await;
    Ok(())
}

fn spawn_background(app: &Arc<App>) {
    tokio::spawn(presence::run(app.clone()));
    if app.config.is_production {
        summary::enable();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_millis(summary::WINDOW_MS as u64));
            t.tick().await;
            loop {
                t.tick().await;
                if let Some(line) = summary::flush(util::now_ms()) {
                    tracing::info!(target: summary::TARGET, module = "http-summary", "{}", line);
                }
            }
        });
    }
    let a = app.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_millis(activity::BATCH_INTERVAL_MS));
        t.tick().await;
        loop {
            t.tick().await;
            a.activity.flush().await;
        }
    });
    let a = app.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_millis(activity::CLEANUP_INTERVAL_MS));
        t.tick().await;
        loop {
            t.tick().await;
            a.activity.cleanup();
        }
    });
    let a = app.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(10 * 60));
        t.tick().await;
        loop {
            t.tick().await;
            a.auth.cleanup();
        }
    });
    let a = app.clone();
    tokio::spawn(async move {
        loop {
            for (label, table) in [("accounts", "\"Account\""), ("sessions", "\"Session\""), ("messages", "\"SessionMessage\""), ("machines", "\"Machine\"")] {
                let r: Result<Option<(Option<i64>,)>, _> =
                    sqlx::query_as("SELECT GREATEST(reltuples, 0)::bigint FROM pg_class WHERE oid = to_regclass($1)").bind(table).fetch_optional(&a.pool).await;
                if let Ok(row) = r {
                    a.metrics.database_records.with_label_values(&[label]).set(row.and_then(|r| r.0).unwrap_or(0) as f64);
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

/// The separate metrics listener (`metrics.ts`).
async fn metrics_server(app: Arc<App>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", app.config.metrics_port)).await?;
    tracing::info!(module = "metrics", "Metrics server listening on port {}", app.config.metrics_port);
    loop {
        let (stream, _) = listener.accept().await?;
        let app = app.clone();
        tokio::spawn(async move {
            let io = hyper_util::rt::TokioIo::new(stream);
            let svc = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let app = app.clone();
                async move {
                    use http_body_util::Full;
                    let path = req.uri().path().to_string();
                    let get = req.method() == hyper::Method::GET || req.method() == hyper::Method::HEAD;
                    let (status, ct, body) = if get && path == "/metrics" {
                        (200, "text/plain; version=0.0.4; charset=utf-8", app.metrics.render())
                    } else if get && path == "/health" {
                        (
                            200,
                            "application/json; charset=utf-8",
                            js::stringify(&serde_json::json!({"status": "ok", "timestamp": util::iso_now()})),
                        )
                    } else {
                        let msg = format!("Route {}:{} not found", req.method(), req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/"));
                        (404, "application/json; charset=utf-8", js::stringify(&serde_json::json!({"message": msg, "error": "Not Found", "statusCode": 404})))
                    };
                    Ok::<_, std::convert::Infallible>(
                        hyper::Response::builder()
                            .status(status)
                            .header("content-type", ct)
                            .header("content-length", body.len().to_string())
                            .body(Full::new(bytes::Bytes::from(body)))
                            .unwrap(),
                    )
                }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await.ok();
}

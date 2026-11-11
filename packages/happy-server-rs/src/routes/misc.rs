//! `/`, `/health` (enableMonitoring) and local `/files/*`.

use crate::app::App;
use crate::config::Config;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use serde_json::json;
use std::sync::Arc;

pub fn register(r: &mut Router, c: &Config) {
    r.get("/").handle(h!(root));
    r.get("/health").handle(h!(health));
    if c.s3.is_none() {
        r.get("/files/*").handle(h!(files));
    }
}

async fn root(_: Arc<App>, _: Req) -> HResult {
    Reply::text(200, "Welcome to Happy Server!")
}

async fn health(app: Arc<App>, _: Req) -> HResult {
    match sqlx::query("SELECT 1").execute(&app.pool).await {
        Ok(_) => Reply::json(json!({
            "status": "ok",
            "timestamp": crate::util::iso_now(),
            "service": "happy-server",
        })),
        Err(e) => {
            tracing::debug!(module = "health", "health:database-check-failed error={}", e);
            Reply::code(
                503,
                json!({
                    "status": "error",
                    "timestamp": crate::util::iso_now(),
                    "service": "happy-server",
                    "error": "Database connectivity failed",
                }),
            )
        }
    }
}

async fn files(app: Arc<App>, req: Req) -> HResult {
    let rel = req.param("*");
    let Some(full) = crate::storage::files::public_local_file_path(app.files.local_dir(), &rel) else {
        return Reply::text(403, "Forbidden");
    };
    if !tokio::fs::try_exists(&full).await.unwrap_or(false) {
        return Reply::text(404, "Not found");
    }
    match tokio::fs::read(&full).await {
        Ok(b) => Reply::stream(b),
        // `fs.createReadStream` on a directory errors after headers are decided:
        // Fastify answers 500 through the error handler.
        Err(e) => Err(e.into()),
    }
}

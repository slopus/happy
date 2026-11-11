//! `presence/timeout.ts`: every minute, sessions and machines without a
//! heartbeat for 10 minutes are marked inactive and user-scoped clients told.

use crate::app::App;
use crate::events::{self, Filter};
use crate::util::naive_to_ms;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const TIMEOUT_MS: i64 = 10 * 60 * 1000;

pub async fn run(app: Arc<App>) {
    loop {
        if let Err(e) = sweep(&app).await {
            tracing::error!(module = "session-timeout", "Error: {}", e);
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn sweep(app: &App) -> anyhow::Result<()> {
    let cutoff = crate::util::ms_to_naive(crate::util::now_ms() - TIMEOUT_MS);
    let sessions: Vec<(String, String)> =
        sqlx::query_as(r#"SELECT "id","accountId" FROM "Session" WHERE "active" = true AND "lastActiveAt" <= $1"#).bind(cutoff).fetch_all(&app.pool).await?;
    for (id, account) in sessions {
        let updated: Option<(chrono::NaiveDateTime,)> =
            sqlx::query_as(r#"UPDATE "Session" SET "active" = false, "updatedAt" = $2 WHERE "id" = $1 AND "active" = true RETURNING "lastActiveAt""#)
                .bind(&id)
                .bind(crate::db::now())
                .fetch_optional(&app.pool)
                .await?;
        if let Some((last,)) = updated {
            app.hub.emit_ephemeral(&account, events::session_activity(&id, false, naive_to_ms(last) as f64, false), Filter::UserScopedOnly);
        }
    }
    let machines: Vec<(String, String)> =
        sqlx::query_as(r#"SELECT "id","accountId" FROM "Machine" WHERE "active" = true AND "lastActiveAt" <= $1"#).bind(cutoff).fetch_all(&app.pool).await?;
    for (id, account) in machines {
        let updated: Option<(chrono::NaiveDateTime,)> =
            sqlx::query_as(r#"UPDATE "Machine" SET "active" = false, "updatedAt" = $2 WHERE "id" = $1 AND "active" = true RETURNING "lastActiveAt""#)
                .bind(&id)
                .bind(crate::db::now())
                .fetch_optional(&app.pool)
                .await?;
        if let Some((last,)) = updated {
            app.hub.emit_ephemeral(&account, events::machine_activity(&json!(id), false, naive_to_ms(last) as f64), Filter::UserScopedOnly);
        }
    }
    Ok(())
}

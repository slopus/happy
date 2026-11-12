//! `v3SessionRoutes.ts`: seq-paged message reads and batched sends.

use super::sessions::{message_from_row, owns_session, MESSAGE_COLS};
use crate::models::Message;
use crate::app::App;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::writer;
use crate::zod::{array, coerce_number, object, string};
use serde_json::{json, Value};
use std::sync::Arc;

fn not_both(v: &Value) -> bool {
    !(v.get("after_seq").is_some() && v.get("before_seq").is_some())
}

pub fn register(r: &mut Router) {
    r.get("/v3/sessions/:sessionId/messages")
        .auth()
        .params(object(vec![("sessionId", string())]))
        .query(
            object(vec![
                ("after_seq", coerce_number().int().min(0.0).optional()),
                ("before_seq", coerce_number().int().min(1.0).optional()),
                ("limit", coerce_number().int().min(1.0).max(500.0).default(json!(100))),
            ])
            .refine(not_both, "after_seq and before_seq are mutually exclusive"),
        )
        .handle(h!(get_messages));

    r.post("/v3/sessions/:sessionId/messages")
        .auth()
        .params(object(vec![("sessionId", string())]))
        .body(object(vec![(
            "messages",
            array(object(vec![("content", string()), ("localId", string().min(1.0))])).min(1.0).max(100.0),
        )]))
        .handle(h!(send_messages));

    if writer::hooks::enabled() {
        // Test-only: `?items=N` holds the session's next batch until N items are queued.
        r.get("/__test/writer/:sessionId")
            .params(object(vec![("sessionId", string())]))
            .query(object(vec![("items", coerce_number().int().min(1.0).optional())]))
            .handle(h!(test_writer));
    }
}

async fn test_writer(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    if let Some(n) = req.query_field("items").and_then(|v| v.as_f64()) {
        writer::hooks::set_gate(&sid, n as usize);
    }
    Reply::json(json!({"queued": writer::hooks::queued(&app, &sid), "batches": writer::hooks::batches(&sid)}))
}

async fn get_messages(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    let after = req.query_field("after_seq").and_then(|v| v.as_f64());
    let before = req.query_field("before_seq").and_then(|v| v.as_f64());
    let limit = req.query_field("limit").and_then(|v| v.as_f64()).unwrap_or(100.0) as i64;

    if !owns_session(&app, &sid, &req.user_id).await? {
        return Reply::code(404, json!({"error": "Session not found"}));
    }
    // Prisma validates `Int` filters as INT4 and throws on larger values.
    for v in [after, before].into_iter().flatten() {
        if v > i32::MAX as f64 {
            anyhow::bail!("Unable to fit integer value '{}' into an INT4 (32-bit signed integer).", v);
        }
    }
    let rows = match before {
        Some(b) => {
            sqlx::query(&format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" < $2 ORDER BY "seq" DESC LIMIT $3"#, MESSAGE_COLS))
                .bind(&sid)
                .bind(b as i64)
                .bind(limit + 1)
                .fetch_all(&app.pool)
                .await?
        }
        None => {
            sqlx::query(&format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" > $2 ORDER BY "seq" ASC LIMIT $3"#, MESSAGE_COLS))
                .bind(&sid)
                .bind(after.unwrap_or(0.0) as i64)
                .bind(limit + 1)
                .fetch_all(&app.pool)
                .await?
        }
    };
    let has_more = rows.len() as i64 > limit;
    let page = if has_more { &rows[..limit as usize] } else { &rows[..] };
    let page: Vec<Message> = page.iter().map(message_from_row).collect();
    crate::history::shadow(&app, &sid, &page, true);
    let messages: Vec<Value> = page.iter().map(|m| m.json()).collect();
    Reply::json(json!({"messages": messages, "hasMore": has_more}))
}

async fn send_messages(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    let input: Vec<(String, String)> = req
        .body_field("messages")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|m| {
                    (
                        m.get("localId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                        m.get("content").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    // First message per localId wins.
    let mut messages: Vec<(String, String)> = Vec::new();
    for (lid, content) in input {
        if !messages.iter().any(|(l, _)| *l == lid) {
            messages.push((lid, content));
        }
    }

    // Ownership, the transaction and the updates run in the session's writer,
    // possibly batched with other writes (see writer.rs).
    let (reply, outcome) = tokio::sync::oneshot::channel();
    writer::submit(&app, &sid, writer::Item::V3(writer::V3Send { user_id: req.user_id.clone(), messages, reply }));
    match outcome.await.map_err(|_| anyhow::anyhow!("message writer stopped"))?? {
        writer::V3Outcome::NotFound => Reply::code(404, json!({"error": "Session not found"})),
        writer::V3Outcome::Sent(body) => Reply::json(body),
    }
}

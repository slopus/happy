//! `v3SessionRoutes.ts`: seq-paged message reads and batched sends.

use super::sessions::{message_from_row, owns_session, MESSAGE_COLS};
use crate::app::App;
use crate::events::{new_message_update, Filter};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::util::{cuid, naive_to_ms};
use crate::zod::{array, coerce_number, object, string};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
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
    let messages: Vec<Value> = page.iter().map(|r| message_from_row(r).json()).collect();
    Reply::json(json!({"messages": messages, "hasMore": has_more}))
}

struct Sent {
    id: String,
    seq: i32,
    local_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl Sent {
    fn json(&self) -> Value {
        json!({"id": self.id, "seq": self.seq, "localId": self.local_id, "createdAt": self.created_at, "updatedAt": self.updated_at})
    }
}

fn sent_from_row(r: &sqlx::postgres::PgRow) -> Sent {
    Sent {
        id: r.get("id"),
        seq: r.get("seq"),
        local_id: r.get("localId"),
        created_at: naive_to_ms(r.get("createdAt")),
        updated_at: naive_to_ms(r.get("updatedAt")),
    }
}

async fn send_messages(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
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

    if !owns_session(&app, &sid, &uid).await? {
        return Reply::code(404, json!({"error": "Session not found"}));
    }

    // First message per localId wins.
    let mut unique: Vec<(String, String)> = Vec::new();
    for (lid, content) in input {
        if !unique.iter().any(|(l, _)| *l == lid) {
            unique.push((lid, content));
        }
    }
    let content_by_local: HashMap<String, String> = unique.iter().cloned().collect();

    let s = sid.clone();
    let (existing, created) = crate::db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let local_ids: Vec<String> = unique.iter().map(|(l, _)| l.clone()).collect();
            let existing: Vec<Sent> = sqlx::query(
                r#"SELECT "id","seq","localId","createdAt","updatedAt" FROM "SessionMessage" WHERE "sessionId" = $1 AND "localId" = ANY($2)"#,
            )
            .bind(&s)
            .bind(&local_ids)
            .fetch_all(&mut *c)
            .await?
            .iter()
            .map(sent_from_row)
            .collect();
            let new: Vec<&(String, String)> = unique.iter().filter(|(l, _)| !existing.iter().any(|e| e.local_id.as_deref() == Some(l.as_str()))).collect();
            let seqs = crate::db::allocate_session_seq_batch(&mut *c, &s, new.len() as i32).await?;
            let mut created: Vec<Sent> = Vec::new();
            if !new.is_empty() {
                let now = crate::db::now();
                let ids: Vec<String> = new.iter().map(|_| cuid()).collect();
                let lids: Vec<String> = new.iter().map(|(l, _)| l.clone()).collect();
                let contents: Vec<String> = new.iter().map(|(_, c)| json!({"t": "encrypted", "c": c}).to_string()).collect();
                created = sqlx::query(
                    r#"INSERT INTO "SessionMessage" ("id","sessionId","localId","seq","content","createdAt","updatedAt")
                       SELECT t.id, $1, t.lid, t.seq, t.content::jsonb, $5, $5
                       FROM UNNEST($2::text[], $3::text[], $4::int4[], $6::text[]) AS t(id, lid, seq, content)
                       RETURNING "id","seq","localId","createdAt","updatedAt""#,
                )
                .bind(&s)
                .bind(&ids)
                .bind(&lids)
                .bind(&seqs)
                .bind(now)
                .bind(&contents)
                .fetch_all(&mut *c)
                .await?
                .iter()
                .map(sent_from_row)
                .collect();
            }
            Ok((existing, created))
        })
    })
    .await?;

    let mut created = created;
    created.sort_by_key(|m| m.seq);
    let to_emit: Vec<&Sent> = created.iter().filter(|m| m.local_id.as_ref().and_then(|l| content_by_local.get(l)).is_some_and(|c| !c.is_empty())).collect();
    if !to_emit.is_empty() {
        // One allocation for the whole batch: the same consecutive user seqs the TS
        // server hands out one by one, in the same message order.
        let first = crate::db::allocate_user_seq_batch(&app.pool, &uid, to_emit.len() as i32).await?;
        for (i, m) in to_emit.iter().enumerate() {
            let content = &content_by_local[m.local_id.as_ref().unwrap()];
            let msg = json!({
                "id": m.id,
                "seq": m.seq,
                "content": {"t": "encrypted", "c": content},
                "localId": m.local_id,
                "createdAt": m.created_at,
                "updatedAt": m.updated_at,
            });
            app.hub.emit_update(&uid, new_message_update(&msg, &sid, first + i as i32), Filter::Session(&sid), None);
        }
    }

    let mut all: Vec<&Sent> = existing.iter().chain(created.iter()).collect();
    all.sort_by_key(|m| m.seq);
    Reply::json(json!({"messages": all.iter().map(|m| m.json()).collect::<Vec<_>>()}))
}

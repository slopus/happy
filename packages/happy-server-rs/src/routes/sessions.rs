//! `sessionRoutes.ts` (v1/v2 sessions, v1 messages, archive, delete).
//! The avatar routes it also registers arrive with the file routes.

use crate::app::App;
use crate::events::{self, Filter, SessionUpdate};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::models::{Message, Session, SESSION_COLS};
use crate::util::{cuid, naive_to_ms, node_b64_decode};
use crate::zod::{coerce_number, object, string};
use serde_json::{json, Value};
use sqlx::Row;
use std::sync::Arc;

pub fn register(r: &mut Router) {
    r.get("/v1/sessions").auth().handle(h!(list_v1));

    r.get("/v2/sessions/active")
        .auth()
        .query(object(vec![("limit", coerce_number().int().min(1.0).max(500.0).default(json!(150)))]).optional())
        .handle(h!(list_active));

    r.get("/v2/sessions")
        .auth()
        .query(
            object(vec![
                ("cursor", string().optional()),
                ("limit", coerce_number().int().min(1.0).max(200.0).default(json!(50))),
                ("changedSince", coerce_number().int().positive().optional()),
            ])
            .optional(),
        )
        .handle(h!(list_v2));

    r.post("/v1/sessions")
        .body(object(vec![
            ("tag", string()),
            ("metadata", string()),
            ("agentState", string().nullish()),
            ("dataEncryptionKey", string().nullish()),
            ("projectId", string().nullish()),
        ]))
        .auth()
        .handle(h!(create));

    r.get("/v1/sessions/:sessionId/messages")
        .params(object(vec![("sessionId", string())]))
        .auth()
        .handle(h!(messages_v1));

    r.post("/v1/sessions/:sessionId/archive")
        .params(object(vec![("sessionId", string())]))
        .auth()
        .handle(h!(archive));

    r.delete("/v1/sessions/:sessionId")
        .params(object(vec![("sessionId", string())]))
        .auth()
        .handle(h!(delete));
}

pub async fn find_session(app: &App, id: &str, uid: &str) -> anyhow::Result<Option<Session>> {
    let row = sqlx::query(&format!(r#"SELECT {} FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#, SESSION_COLS))
        .bind(id)
        .bind(uid)
        .fetch_optional(&app.pool)
        .await?;
    Ok(row.as_ref().map(Session::from_row))
}

pub async fn owns_session(app: &App, id: &str, uid: &str) -> anyhow::Result<bool> {
    let r: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
        .bind(id)
        .bind(uid)
        .fetch_optional(&app.pool)
        .await?;
    Ok(r.is_some())
}

async fn list_v1(app: Arc<App>, req: Req) -> HResult {
    let rows = sqlx::query(&format!(r#"SELECT {} FROM "Session" WHERE "accountId" = $1 ORDER BY "updatedAt" DESC LIMIT 150"#, SESSION_COLS))
        .bind(&req.user_id)
        .fetch_all(&app.pool)
        .await?;
    let sessions: Vec<Value> = rows.iter().map(|r| Session::from_row(r).list_json(true)).collect();
    Reply::json(json!({ "sessions": sessions }))
}

fn query_limit(req: &Req, default: i64) -> i64 {
    // `request.query?.limit || default`
    match req.query_field("limit").and_then(|v| v.as_f64()) {
        Some(n) if n != 0.0 && !n.is_nan() => n as i64,
        _ => default,
    }
}

async fn list_active(app: Arc<App>, req: Req) -> HResult {
    let limit = query_limit(&req, 150);
    let since = crate::util::ms_to_naive(crate::util::now_ms() - 15 * 60 * 1000);
    let rows = sqlx::query(&format!(
        r#"SELECT {} FROM "Session" WHERE "accountId" = $1 AND "active" = true AND "lastActiveAt" > $2 ORDER BY "lastActiveAt" DESC LIMIT $3"#,
        SESSION_COLS
    ))
    .bind(&req.user_id)
    .bind(since)
    .bind(limit)
    .fetch_all(&app.pool)
    .await?;
    let sessions: Vec<Value> = rows.iter().map(|r| Session::from_row(r).list_json(false)).collect();
    Reply::json(json!({ "sessions": sessions }))
}

async fn list_v2(app: Arc<App>, req: Req) -> HResult {
    let cursor = req.query_field("cursor").and_then(|v| v.as_str()).map(|s| s.to_string());
    let limit = req.query_field("limit").and_then(|v| v.as_f64()).map(|n| n as i64).unwrap_or(50);
    let changed_since = req.query_field("changedSince").and_then(|v| v.as_f64()).filter(|n| *n != 0.0);

    let mut cursor_id: Option<String> = None;
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        match c.strip_prefix("cursor_v1_") {
            // `cursor.substring(10)`; an empty remainder is falsy and ignored.
            Some(rest) => cursor_id = Some(rest.to_string()).filter(|s| !s.is_empty()),
            None => return Reply::code(400, json!({"error": "Invalid cursor format"})),
        }
    }
    let changed = changed_since.map(super::js_date_ms).transpose()?;
    let rows = sqlx::query(&format!(
        r#"SELECT {} FROM "Session"
           WHERE "accountId" = $1 AND ($2::timestamp IS NULL OR "updatedAt" > $2) AND ($3::text IS NULL OR "id" < $3)
           ORDER BY "id" DESC LIMIT $4"#,
        SESSION_COLS
    ))
    .bind(&req.user_id)
    .bind(changed)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&app.pool)
    .await?;
    let has_next = rows.len() as i64 > limit;
    let page = if has_next { &rows[..limit as usize] } else { &rows[..] };
    let sessions: Vec<Session> = page.iter().map(Session::from_row).collect();
    let next_cursor = if has_next { sessions.last().map(|s| format!("cursor_v1_{}", s.id)) } else { None };
    Reply::json(json!({
        "sessions": sessions.iter().map(|s| s.list_json(false)).collect::<Vec<_>>(),
        "nextCursor": next_cursor,
        "hasNext": has_next,
    }))
}

async fn create(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let tag = req.body_str("tag").unwrap_or_default();
    let metadata = req.body_str("metadata").unwrap_or_default();
    let dek = req.body_field("dataEncryptionKey").and_then(|v| v.as_str()).map(|s| s.to_string());
    // `projectId` distinguishes undefined (absent) from null.
    let project_id: Option<Option<String>> = req.body_field("projectId").map(|v| v.as_str().map(|s| s.to_string()));

    if let Some(Some(pid)) = &project_id {
        let found: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Project" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
            .bind(pid)
            .bind(&uid)
            .fetch_optional(&app.pool)
            .await?;
        if found.is_none() {
            return Reply::code(404, json!({"error": "Project not found"}));
        }
    }

    let existing = sqlx::query(&format!(r#"SELECT {} FROM "Session" WHERE "accountId" = $1 AND "tag" = $2 LIMIT 1"#, SESSION_COLS))
        .bind(&uid)
        .bind(&tag)
        .fetch_optional(&app.pool)
        .await?
        .map(|r| Session::from_row(&r));

    if let Some(session) = existing {
        tracing::info!(module = "session-create", "Found existing session: {} for tag {}", session.id, tag);
        let mut for_response = session.clone();
        if let Some(pid) = &project_id {
            if *pid != session.project_id {
                let row = sqlx::query(&format!(r#"UPDATE "Session" SET "projectId" = $1, "updatedAt" = $2 WHERE "id" = $3 RETURNING {}"#, SESSION_COLS))
                    .bind(pid)
                    .bind(crate::db::now())
                    .bind(&session.id)
                    .fetch_optional(&app.pool)
                    .await?
                    .ok_or(crate::db::RecordNotFound)?;
                for_response = Session::from_row(&row);
                let seq = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
                let payload = events::update_session_update(
                    &session.id,
                    seq,
                    SessionUpdate {
                        metadata: None,
                        agent_state: None,
                        project_id: Some(json!(pid)),
                        avatar: None,
                        avatar_version: None,
                    },
                );
                app.hub.emit_update(&uid, payload, Filter::UserScopedOnly, None);
            }
        }
        app.activity.resume_session_updates(&session.id);
        return Reply::json(json!({ "session": for_response.create_json() }));
    }

    let seq = crate::db::allocate_user_seq_pool(&app.pool, &uid).await?;
    tracing::info!(module = "session-create", "Creating new session for user {} with tag {}", uid, tag);
    // `dataEncryptionKey ? Buffer.from(x, 'base64') : undefined`
    let dek_bytes = dek.filter(|s| !s.is_empty()).map(|s| node_b64_decode(&s));
    let now = crate::db::now();
    let row = sqlx::query(&format!(
        r#"INSERT INTO "Session" ("id","tag","accountId","projectId","avatarVersion","metadata","metadataVersion","agentStateVersion","dataEncryptionKey","seq","active","lastActiveAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,0,$5,0,0,$6,0,true,$7,$7,$7) RETURNING {}"#,
        SESSION_COLS
    ))
    .bind(cuid())
    .bind(&tag)
    .bind(&uid)
    .bind(project_id.flatten())
    .bind(&metadata)
    .bind(dek_bytes)
    .bind(now)
    .fetch_one(&app.pool)
    .await?;
    let session = Session::from_row(&row);
    tracing::info!(module = "session-create", "Session created: {}", session.id);
    let payload = events::new_session_update(&session, seq);
    app.hub.emit_update(&uid, payload, Filter::UserScopedOnly, None);
    Reply::json(json!({ "session": session.create_json() }))
}

pub const MESSAGE_COLS: &str = r#""id","seq","localId","content"::text AS "content","createdAt","updatedAt""#;

pub fn message_from_row(r: &sqlx::postgres::PgRow) -> Message {
    Message {
        id: r.get("id"),
        seq: r.get("seq"),
        local_id: r.get("localId"),
        content: r.get("content"),
        created_at: naive_to_ms(r.get("createdAt")),
        updated_at: naive_to_ms(r.get("updatedAt")),
    }
}

async fn messages_v1(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    if find_session(&app, &sid, &req.user_id).await?.is_none() {
        return Reply::code(404, json!({"error": "Session not found"}));
    }
    let rows = sqlx::query(&format!(
        r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC, "seq" DESC LIMIT 150"#,
        MESSAGE_COLS
    ))
    .bind(&sid)
    .fetch_all(&app.pool)
    .await?;
    let messages: Vec<Value> = rows.iter().map(|r| message_from_row(r).json()).collect();
    Reply::json(json!({ "messages": messages }))
}

async fn archive(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    app.activity.clear_session_updates(&sid);
    let now = crate::db::now();
    let n = sqlx::query(r#"UPDATE "Session" SET "active" = false, "lastActiveAt" = $1, "updatedAt" = $1 WHERE "id" = $2 AND "accountId" = $3"#)
        .bind(now)
        .bind(&sid)
        .bind(&req.user_id)
        .execute(&app.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Reply::code(404, json!({"error": "Session not found"}));
    }
    let activity = events::session_activity(&sid, false, crate::util::now_ms() as f64, false);
    app.hub.emit_ephemeral(&req.user_id, activity, Filter::UserScopedOnly);
    Reply::json(json!({"success": true}))
}

async fn delete(app: Arc<App>, req: Req) -> HResult {
    let sid = req.param("sessionId");
    app.activity.clear_session_updates(&sid);
    if !session_delete(&app, &req.user_id, &sid).await? {
        return Reply::code(404, json!({"error": "Session not found or not owned by user"}));
    }
    Reply::json(json!({"success": true}))
}

/// `sessionDelete`: SERIALIZABLE transaction, then (not awaited) the update and
/// blob cleanup.
pub async fn session_delete(app: &Arc<App>, uid: &str, sid: &str) -> anyhow::Result<bool> {
    let (u, s) = (uid.to_string(), sid.to_string());
    let deleted = crate::db::in_tx(&app.pool, move |c| {
        let (u, s) = (u.clone(), s.clone());
        Box::pin(async move {
            let found: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
                .bind(&s)
                .bind(&u)
                .fetch_optional(&mut *c)
                .await?;
            if found.is_none() {
                tracing::info!(module = "session-delete", "Session not found or not owned by user");
                return Ok(false);
            }
            let m = sqlx::query(r#"DELETE FROM "SessionMessage" WHERE "sessionId" = $1"#).bind(&s).execute(&mut *c).await?.rows_affected();
            tracing::info!(module = "session-delete", "Deleted {} session messages", m);
            let r = sqlx::query(r#"DELETE FROM "UsageReport" WHERE "sessionId" = $1"#).bind(&s).execute(&mut *c).await?.rows_affected();
            tracing::info!(module = "session-delete", "Deleted {} usage reports", r);
            let k = sqlx::query(r#"DELETE FROM "AccessKey" WHERE "sessionId" = $1"#).bind(&s).execute(&mut *c).await?.rows_affected();
            tracing::info!(module = "session-delete", "Deleted {} access keys", k);
            crate::db::expect_row(sqlx::query(r#"DELETE FROM "Session" WHERE "id" = $1"#).bind(&s).execute(&mut *c).await?)?;
            tracing::info!(module = "session-delete", "Session deleted successfully");
            Ok(true)
        })
    })
    .await?;
    if deleted {
        let app = app.clone();
        let (uid, sid) = (uid.to_string(), sid.to_string());
        tokio::spawn(async move {
            match crate::db::allocate_user_seq_pool(&app.pool, &uid).await {
                Ok(seq) => {
                    let payload = events::simple_update(seq, "delete-session", "sid", &sid);
                    app.hub.emit_update(&uid, payload, Filter::UserScopedOnly, None);
                }
                Err(e) => {
                    // TS: an unhandled rejection here terminates the process.
                    tracing::error!(module = "session-delete", "delete-session update failed: {}", e);
                    return;
                }
            }
            if let Err(e) = app.files.delete_session_avatars(&sid).await {
                tracing::info!(module = "session-delete", "Failed to delete session avatars (non-fatal): {}", e);
            }
            match app.files.delete_session_attachments(&sid).await {
                Ok(()) => tracing::info!(module = "session-delete", "Attachment blobs deleted"),
                Err(e) => tracing::info!(module = "session-delete", "Failed to delete attachment blobs (non-fatal): {}", e),
            }
        });
    }
    Ok(deleted)
}

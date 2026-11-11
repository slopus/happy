//! `pushRoutes.ts` with `app/push/*` (Expo HTTP push API, presence suppression).

use crate::app::App;
use crate::events::{self, Filter};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::js;
use crate::util::{cuid, naive_to_ms};
use crate::zod::{enumeration, literal, number, object, record, string};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;

pub fn register(r: &mut Router) {
    r.post("/v1/push-tokens")
        .body(object(vec![("token", string())]))
        .response(200, object(vec![("success", literal(json!(true)))]))
        .response(500, object(vec![("error", literal(json!("Failed to register push token")))]))
        .auth()
        .handle(h!(register_token));

    r.delete("/v1/push-tokens/:token")
        .params(object(vec![("token", string())]))
        .response(200, object(vec![("success", literal(json!(true)))]))
        .response(500, object(vec![("error", literal(json!("Failed to delete push token")))]))
        .auth()
        .handle(h!(delete_token));

    r.post("/v1/sessions/:sessionId/push-event")
        .params(object(vec![("sessionId", string())]))
        .body(object(vec![
            ("kind", enumeration(&["done", "permission", "question"])),
            ("title", string().min(1.0).max(200.0)),
            ("body", string().min(1.0).max(500.0)),
            ("data", record().optional()),
        ]))
        .response(
            200,
            object(vec![
                ("success", literal(json!(true))),
                ("result", enumeration(&["sent", "partial", "suppressed", "no_tokens", "failed"])),
                ("tokens", number().optional()),
                ("delivered", number().optional()),
                ("reason", string().optional()),
            ]),
        )
        .response(404, object(vec![("error", literal(json!("Session not found")))]))
        .auth()
        .handle(h!(push_event));

    r.get("/v1/push-tokens").auth().handle(h!(list_tokens));
}

async fn register_token(app: Arc<App>, req: Req) -> HResult {
    let now = crate::db::now();
    let r = sqlx::query(
        r#"INSERT INTO "AccountPushToken" ("id","accountId","token","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$4)
           ON CONFLICT ("accountId","token") DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt""#,
    )
    .bind(cuid())
    .bind(&req.user_id)
    .bind(req.body_str("token").unwrap_or_default())
    .bind(now)
    .execute(&app.pool)
    .await;
    match r {
        Ok(_) => Reply::json(json!({"success": true})),
        Err(_) => Reply::error(500, "Failed to register push token"),
    }
}

async fn delete_token(app: Arc<App>, req: Req) -> HResult {
    let r = sqlx::query(r#"DELETE FROM "AccountPushToken" WHERE "accountId" = $1 AND "token" = $2"#)
        .bind(&req.user_id)
        .bind(req.param("token"))
        .execute(&app.pool)
        .await;
    match r {
        Ok(_) => Reply::json(json!({"success": true})),
        Err(_) => Reply::error(500, "Failed to delete push token"),
    }
}

async fn list_tokens(app: Arc<App>, req: Req) -> HResult {
    let rows: Result<Vec<(String, String, chrono::NaiveDateTime, chrono::NaiveDateTime)>, _> =
        sqlx::query_as(r#"SELECT "id","token","createdAt","updatedAt" FROM "AccountPushToken" WHERE "accountId" = $1 ORDER BY "createdAt" DESC"#)
            .bind(&req.user_id)
            .fetch_all(&app.pool)
            .await;
    match rows {
        Ok(rows) => Reply::json(json!({
            "tokens": rows.iter().map(|(id, t, c, u)| json!({"id": id, "token": t, "createdAt": naive_to_ms(*c), "updatedAt": naive_to_ms(*u)})).collect::<Vec<_>>()
        })),
        Err(_) => Reply::error(500, "Failed to get push tokens"),
    }
}

async fn push_event(app: Arc<App>, req: Req) -> HResult {
    let (uid, sid) = (req.user_id.clone(), req.param("sessionId"));
    if !super::sessions::owns_session(&app, &sid, &uid).await? {
        return Reply::error(404, "Session not found");
    }
    let kind = req.body_str("kind").unwrap_or_default();
    let title = req.body_str("title").unwrap_or_default();
    let body = req.body_str("body").unwrap_or_default();
    app.hub.emit_ephemeral(&uid, events::session_event_ephemeral(&sid, &kind, &title, &body), Filter::Session(&sid));

    // `{ sessionId, ...{ ...(data ?? {}), kind } }`: assignment keeps a key's first
    // position, and integer-like keys sort first.
    let mut data = Map::new();
    data.insert("sessionId".into(), json!(sid));
    if let Some(Value::Object(d)) = req.body_field("data") {
        for (k, v) in d {
            data.insert(k.clone(), v.clone());
        }
    }
    data.insert("kind".into(), json!(kind));
    js::js_order(&mut data);

    let mut out = Map::new();
    out.insert("success".into(), json!(true));
    for (k, v) in dispatch(&app, &uid, &sid, &title, &body, Value::Object(data)).await {
        out.insert(k, v);
    }
    Reply::json(Value::Object(out))
}

/// `dispatchSessionEventPush`: the outcome as `{ result, … }` fields.
async fn dispatch(app: &App, uid: &str, sid: &str, title: &str, body: &str, data: Value) -> Map<String, Value> {
    if app.hub.has_active_ui_client(uid) {
        tracing::info!(module = "push", "Suppressed session-event push for user {} session {}: user active", uid, sid);
        return outcome(json!({"result": "suppressed", "reason": "active-ui-client"}));
    }
    match fetch_tokens_and_send(app, uid, sid, title, body, data).await {
        Ok(o) => outcome(o),
        Err(e) => {
            tracing::error!(module = "push", "Session-event push dispatch failed: {}", e);
            outcome(json!({"result": "failed", "reason": e.to_string()}))
        }
    }
}

fn outcome(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

async fn fetch_tokens_and_send(app: &App, uid: &str, sid: &str, title: &str, body: &str, data: Value) -> anyhow::Result<Value> {
    let tokens: Vec<(String, String)> =
        sqlx::query_as(r#"SELECT "id","token" FROM "AccountPushToken" WHERE "accountId" = $1"#).bind(uid).fetch_all(&app.pool).await?;
    if tokens.is_empty() {
        tracing::info!(module = "push", "No push tokens for user {} session {} — skipped", uid, sid);
        return Ok(json!({"result": "no_tokens"}));
    }
    let messages: Vec<Value> = tokens
        .iter()
        .map(|(_, t)| json!({"to": t, "title": title, "body": body, "data": data, "sound": "default", "channelId": "messages"}))
        .collect();
    let tickets = send(&app.config.expo_push_url, &messages).await;

    let mut ok = 0;
    let mut errors: Vec<String> = Vec::new();
    for (i, ticket) in tickets.iter().enumerate() {
        // `ticket.status` on a non-object ticket throws (caught by the dispatcher).
        if ticket.is_null() {
            anyhow::bail!("Cannot read properties of null (reading 'status')");
        }
        if js::get(Some(ticket), "status").and_then(|s| s.as_str()) == Some("ok") {
            ok += 1;
            continue;
        }
        let details_error = js::get(js::get(Some(ticket), "details"), "error");
        let reason = [details_error, js::get(Some(ticket), "message")]
            .into_iter()
            .flatten()
            .find(|v| js::truthy(Some(v)))
            .map(js::to_js_string)
            .unwrap_or_else(|| "unknown".into());
        errors.push(reason);
        if details_error.and_then(|v| v.as_str()) == Some("DeviceNotRegistered") {
            // `tokens[i].id` throws when Expo returns more tickets than were sent.
            // The token itself is never deleted: `void db.accountPushToken.deleteMany(...)`
            // builds a lazy PrismaPromise that nothing awaits, so it never runs (QUIRKS 42).
            if tokens.get(i).is_none() {
                anyhow::bail!("Cannot read properties of undefined (reading 'id')");
            }
        }
    }
    if errors.is_empty() {
        tracing::info!(module = "push", "Push sent for user {} session {}: {} token(s)", uid, sid, ok);
        return Ok(json!({"result": "sent", "tokens": ok}));
    }
    if ok == 0 {
        tracing::error!(module = "push", "Push failed for user {} session {}: errors={:?}", uid, sid, errors);
        return Ok(json!({"result": "failed", "reason": errors.join(", ")}));
    }
    tracing::warn!(module = "push", "Push partial for user {} session {}: ok={} errors={:?}", uid, sid, ok, errors);
    Ok(json!({"result": "partial", "tokens": tokens.len(), "delivered": ok, "reason": errors.join(", ")}))
}

/// `sendPushNotifications`: batches of 100 under one 8 s deadline; a failed batch
/// becomes one error ticket per message.
async fn send(url: &str, messages: &[Value]) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(8_000);
    let mut tickets = Vec::new();
    for batch in messages.chunks(100) {
        let r = tokio::time::timeout_at(deadline, async {
            let resp = crate::fetch::CLIENT.post(url).header("Content-Type", "application/json").body(js::stringify(&Value::Array(batch.to_vec()))).send().await?;
            if !resp.status().is_success() {
                return Ok::<_, anyhow::Error>(Err(resp.status().as_u16()));
            }
            let v = crate::fetch::json(resp).await?;
            // `tickets.push(...result.data)` throws unless `data` is iterable.
            match js::get(Some(&v), "data") {
                Some(Value::Array(a)) => Ok(Ok(a.clone())),
                Some(Value::String(s)) => Ok(Ok(s.chars().map(|c| Value::String(c.to_string())).collect())),
                _ => anyhow::bail!("result.data is not iterable"),
            }
        })
        .await;
        match r {
            Ok(Ok(Ok(t))) => tickets.extend(t),
            Ok(Ok(Err(status))) => tickets.extend(batch.iter().map(|_| json!({"status": "error", "message": format!("HTTP {}", status)}))),
            _ => tickets.extend(batch.iter().map(|_| json!({"status": "error", "message": "Network error"}))),
        }
    }
    tickets
}

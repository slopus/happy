//! `accessKeysRoutes.ts`.

use crate::app::App;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::util::{cuid, naive_to_ms};
use crate::zod::{literal, number, object, string, union, S};
use chrono::NaiveDateTime;
use serde_json::{json, Value};
use std::sync::Arc;

fn params() -> S {
    object(vec![("sessionId", string()), ("machineId", string())])
}

fn key_schema() -> S {
    object(vec![("data", string()), ("dataVersion", number()), ("createdAt", number()), ("updatedAt", number())])
}

pub fn register(r: &mut Router) {
    r.get("/v1/access-keys/:sessionId/:machineId")
        .auth()
        .params(params())
        .response(200, object(vec![("accessKey", key_schema().nullable())]))
        .response(404, object(vec![("error", literal(json!("Session or machine not found")))]))
        .response(500, object(vec![("error", literal(json!("Failed to get access key")))]))
        .handle(h!(get));

    r.post("/v1/access-keys/:sessionId/:machineId")
        .auth()
        .params(params())
        .body(object(vec![("data", string())]))
        .response(
            200,
            object(vec![("success", crate::zod::boolean()), ("accessKey", key_schema().optional()), ("error", string().optional())]),
        )
        .response(404, object(vec![("error", literal(json!("Session or machine not found")))]))
        .response(409, object(vec![("error", literal(json!("Access key already exists")))]))
        .response(500, object(vec![("error", literal(json!("Failed to create access key")))]))
        .handle(h!(create));

    r.put("/v1/access-keys/:sessionId/:machineId")
        .auth()
        .params(params())
        .body(object(vec![("data", string()), ("expectedVersion", number().int().min(0.0))]))
        .response(
            200,
            union(vec![
                object(vec![("success", literal(json!(true))), ("version", number())]),
                object(vec![
                    ("success", literal(json!(false))),
                    ("error", literal(json!("version-mismatch"))),
                    ("currentVersion", number()),
                    ("currentData", string()),
                ]),
            ]),
        )
        .response(404, object(vec![("error", literal(json!("Access key not found")))]))
        .response(500, object(vec![("success", literal(json!(false))), ("error", literal(json!("Failed to update access key")))]))
        .handle(h!(update));
}

type Key = (String, i32, NaiveDateTime, NaiveDateTime);

fn key_json(k: &Key) -> Value {
    json!({ "data": k.0, "dataVersion": k.1, "createdAt": naive_to_ms(k.2), "updatedAt": naive_to_ms(k.3) })
}

async fn find_key(app: &App, uid: &str, mid: &str, sid: &str) -> anyhow::Result<Option<Key>> {
    Ok(sqlx::query_as(
        r#"SELECT "data","dataVersion","createdAt","updatedAt" FROM "AccessKey" WHERE "accountId" = $1 AND "machineId" = $2 AND "sessionId" = $3"#,
    )
    .bind(uid)
    .bind(mid)
    .bind(sid)
    .fetch_optional(&app.pool)
    .await?)
}

/// `Promise.all([session.findFirst, machine.findFirst])`: both must belong to the user.
async fn owns_both(app: &App, uid: &str, sid: &str, mid: &str) -> anyhow::Result<bool> {
    let (s, m) = tokio::try_join!(super::sessions::owns_session(app, sid, uid), async {
        let r: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Machine" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
            .bind(mid)
            .bind(uid)
            .fetch_optional(&app.pool)
            .await?;
        Ok::<_, anyhow::Error>(r.is_some())
    })?;
    Ok(s && m)
}

async fn get(app: Arc<App>, req: Req) -> HResult {
    let (sid, mid) = (req.param("sessionId"), req.param("machineId"));
    let r: anyhow::Result<Reply> = async {
        if !owns_both(&app, &req.user_id, &sid, &mid).await? {
            return Reply::error(404, "Session or machine not found");
        }
        let key = find_key(&app, &req.user_id, &mid, &sid).await?;
        Reply::json(json!({ "accessKey": key.as_ref().map(key_json) }))
    }
    .await;
    r.or_else(|e| {
        tracing::error!(module = "api", "Failed to get access key: {}", e);
        Reply::error(500, "Failed to get access key")
    })
}

async fn create(app: Arc<App>, req: Req) -> HResult {
    let (uid, sid, mid) = (req.user_id.clone(), req.param("sessionId"), req.param("machineId"));
    let data = req.body_str("data").unwrap_or_default();
    let r: anyhow::Result<Reply> = async {
        if !owns_both(&app, &uid, &sid, &mid).await? {
            return Reply::error(404, "Session or machine not found");
        }
        if find_key(&app, &uid, &mid, &sid).await?.is_some() {
            return Reply::error(409, "Access key already exists");
        }
        let now = crate::db::now();
        let key: Key = sqlx::query_as(
            r#"INSERT INTO "AccessKey" ("id","accountId","machineId","sessionId","data","dataVersion","createdAt","updatedAt")
               VALUES ($1,$2,$3,$4,$5,1,$6,$6) RETURNING "data","dataVersion","createdAt","updatedAt""#,
        )
        .bind(cuid())
        .bind(&uid)
        .bind(&mid)
        .bind(&sid)
        .bind(&data)
        .bind(now)
        .fetch_one(&app.pool)
        .await?;
        tracing::info!(module = "access-keys", "Created new access key");
        Reply::json(json!({ "success": true, "accessKey": key_json(&key) }))
    }
    .await;
    r.or_else(|e| {
        tracing::error!(module = "api", "Failed to create access key: {}", e);
        Reply::error(500, "Failed to create access key")
    })
}

async fn update(app: Arc<App>, req: Req) -> HResult {
    let (uid, sid, mid) = (req.user_id.clone(), req.param("sessionId"), req.param("machineId"));
    let data = req.body_str("data").unwrap_or_default();
    let expected = req.body_field("expectedVersion").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
    let r: anyhow::Result<Reply> = async {
        let Some(current) = find_key(&app, &uid, &mid, &sid).await? else {
            return Reply::error(404, "Access key not found");
        };
        if current.1 as i64 != expected {
            return Reply::json(json!({ "success": false, "error": "version-mismatch", "currentVersion": current.1, "currentData": current.0 }));
        }
        let n = sqlx::query(
            r#"UPDATE "AccessKey" SET "data" = $1, "dataVersion" = $2, "updatedAt" = $3
               WHERE "accountId" = $4 AND "machineId" = $5 AND "sessionId" = $6 AND "dataVersion" = $7"#,
        )
        .bind(&data)
        .bind((expected + 1) as i32)
        .bind(crate::db::now())
        .bind(&uid)
        .bind(&mid)
        .bind(&sid)
        .bind(expected as i32)
        .execute(&app.pool)
        .await?
        .rows_affected();
        if n == 0 {
            let k = find_key(&app, &uid, &mid, &sid).await?;
            // `accessKey?.dataVersion || 0`, `accessKey?.data || ''`
            return Reply::json(json!({
                "success": false,
                "error": "version-mismatch",
                "currentVersion": k.as_ref().map(|k| k.1).unwrap_or(0),
                "currentData": k.map(|k| k.0).unwrap_or_default(),
            }));
        }
        tracing::info!(module = "access-keys", "Updated access key to version {}", expected + 1);
        Reply::json(json!({ "success": true, "version": expected + 1 }))
    }
    .await;
    r.or_else(|e| {
        tracing::error!(module = "api", "Failed to update access key: {}", e);
        Reply::code(500, json!({"success": false, "error": "Failed to update access key"}))
    })
}

//! `authRoutes.ts`.

use crate::app::App;
use crate::auth::nacl_verify;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::util::{cuid, hex_upper, stablelib_b64_decode};
use crate::zod::{boolean, literal, object, string, union};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::sync::Arc;

pub fn register(r: &mut Router) {
    r.post("/v1/auth")
        .body(object(vec![("publicKey", string()), ("challenge", string()), ("signature", string())]))
        .handle(h!(auth));

    let state_response = || {
        union(vec![
            object(vec![("state", literal(json!("requested")))]),
            object(vec![("state", literal(json!("authorized"))), ("token", string()), ("response", string())]),
        ])
    };
    r.post("/v1/auth/request")
        .body(object(vec![("publicKey", string()), ("supportsV2", boolean().nullish())]))
        .response(200, state_response())
        .response(401, object(vec![("error", literal(json!("Invalid public key")))]))
        .handle(h!(request));

    r.get("/v1/auth/request/status")
        .query(object(vec![("publicKey", string())]))
        .response(
            200,
            object(vec![
                ("status", crate::zod::enumeration(&["not_found", "pending", "authorized"])),
                ("supportsV2", boolean()),
            ]),
        )
        .handle(h!(request_status));

    r.post("/v1/auth/response")
        .auth()
        .body(object(vec![("response", string()), ("publicKey", string())]))
        .handle(h!(response));

    r.post("/v1/auth/account/request")
        .body(object(vec![("publicKey", string())]))
        .response(200, state_response())
        .response(401, object(vec![("error", literal(json!("Invalid public key")))]))
        .handle(h!(account_request));

    r.post("/v1/auth/account/response")
        .auth()
        .body(object(vec![("response", string()), ("publicKey", string())]))
        .handle(h!(account_response));
}

/// `privacyKit.decodeBase64`; a decode failure throws (→ 500).
fn b64(s: &str) -> anyhow::Result<Vec<u8>> {
    stablelib_b64_decode(s).map_err(|e| anyhow::anyhow!(e))
}

async fn auth(app: Arc<App>, req: Req) -> HResult {
    let public_key = b64(&req.body_str("publicKey").unwrap_or_default())?;
    let challenge = b64(&req.body_str("challenge").unwrap_or_default())?;
    let signature = b64(&req.body_str("signature").unwrap_or_default())?;
    let valid = nacl_verify(&challenge, &signature, &public_key).map_err(|e| anyhow::anyhow!(e))?;
    if !valid {
        return Reply::code(401, json!({"error": "Invalid signature"}));
    }
    let hex = hex_upper(&public_key);
    let now = crate::db::now();
    let row = sqlx::query(
        r#"INSERT INTO "Account" ("id","publicKey","seq","feedSeq","createdAt","updatedAt","settingsVersion")
           VALUES ($1,$2,0,0,$3,$3,0)
           ON CONFLICT ("publicKey") DO UPDATE SET "updatedAt" = $4
           RETURNING "id""#,
    )
    .bind(cuid())
    .bind(&hex)
    .bind(now)
    .bind(now)
    .fetch_one(&app.pool)
    .await?;
    let id: String = row.get(0);
    Reply::json(json!({"success": true, "token": app.auth.create_token(&id, None)}))
}

struct AuthRequestRow {
    id: String,
    supports_v2: bool,
    response: Option<String>,
    response_account_id: Option<String>,
}

async fn find_terminal_request(app: &App, hex: &str) -> anyhow::Result<Option<AuthRequestRow>> {
    let r = sqlx::query(r#"SELECT "id","supportsV2","response","responseAccountId" FROM "TerminalAuthRequest" WHERE "publicKey" = $1 LIMIT 1"#)
        .bind(hex)
        .fetch_optional(&app.pool)
        .await?;
    Ok(r.map(|r| AuthRequestRow {
        id: r.get("id"),
        supports_v2: r.get("supportsV2"),
        response: r.get("response"),
        response_account_id: r.get("responseAccountId"),
    }))
}

async fn find_account_request(app: &App, hex: &str) -> anyhow::Result<Option<AuthRequestRow>> {
    let r = sqlx::query(r#"SELECT "id","response","responseAccountId" FROM "AccountAuthRequest" WHERE "publicKey" = $1 LIMIT 1"#)
        .bind(hex)
        .fetch_optional(&app.pool)
        .await?;
    Ok(r.map(|r| AuthRequestRow { id: r.get("id"), supports_v2: false, response: r.get("response"), response_account_id: r.get("responseAccountId") }))
}

/// `tweetnacl.box.publicKeyLength === publicKey.length`.
fn box_key(s: &str) -> anyhow::Result<Option<String>> {
    let pk = b64(s)?;
    Ok(if pk.len() == 32 { Some(hex_upper(&pk)) } else { None })
}

async fn request(app: Arc<App>, req: Req) -> HResult {
    let Some(hex) = box_key(&req.body_str("publicKey").unwrap_or_default())? else {
        return Reply::code(401, json!({"error": "Invalid public key"}));
    };
    tracing::info!(module = "auth-request", "Terminal auth request - publicKey hex: {}", hex);
    let supports_v2 = req.body_field("supportsV2").and_then(|v| v.as_bool()).unwrap_or(false);
    // Prisma upsert with an empty update: read, else create.
    let answer = match find_terminal_request(&app, &hex).await? {
        Some(a) => a,
        None => {
            let now = crate::db::now();
            let id = cuid();
            sqlx::query(r#"INSERT INTO "TerminalAuthRequest" ("id","publicKey","supportsV2","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$4)"#)
                .bind(&id)
                .bind(&hex)
                .bind(supports_v2)
                .bind(now)
                .execute(&app.pool)
                .await?;
            AuthRequestRow { id, supports_v2, response: None, response_account_id: None }
        }
    };
    if let (Some(resp), Some(acc)) = (answer.response.filter(|s| !s.is_empty()), answer.response_account_id.filter(|s| !s.is_empty())) {
        let mut extras = Map::new();
        extras.insert("session".into(), Value::String(answer.id.clone()));
        let token = app.auth.create_token(&acc, Some(&extras));
        return Reply::json(json!({"state": "authorized", "token": token, "response": resp}));
    }
    Reply::json(json!({"state": "requested"}))
}

async fn request_status(app: Arc<App>, req: Req) -> HResult {
    let pk = req.query_field("publicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let Some(hex) = box_key(&pk)? else {
        return Reply::json(json!({"status": "not_found", "supportsV2": false}));
    };
    let Some(r) = find_terminal_request(&app, &hex).await? else {
        return Reply::json(json!({"status": "not_found", "supportsV2": false}));
    };
    if r.response.as_deref().is_some_and(|s| !s.is_empty()) && r.response_account_id.as_deref().is_some_and(|s| !s.is_empty()) {
        return Reply::json(json!({"status": "authorized", "supportsV2": false}));
    }
    Reply::json(json!({"status": "pending", "supportsV2": r.supports_v2}))
}

async fn response(app: Arc<App>, req: Req) -> HResult {
    let pk_str = req.body_str("publicKey").unwrap_or_default();
    tracing::info!(
        module = "auth-response",
        "Auth response endpoint hit - user: {}, publicKey: {}...",
        req.user_id,
        pk_str.encode_utf16().take(20).map(|c| char::from_u32(c as u32).unwrap_or('\u{FFFD}')).collect::<String>()
    );
    let Some(hex) = box_key(&pk_str)? else {
        return Reply::code(401, json!({"error": "Invalid public key"}));
    };
    let Some(r) = find_terminal_request(&app, &hex).await? else {
        tracing::info!(module = "auth-response", "Auth request not found for publicKey: {}", hex);
        return Reply::code(404, json!({"error": "Request not found"}));
    };
    if r.response.as_deref().map_or(true, |s| s.is_empty()) {
        sqlx::query(r#"UPDATE "TerminalAuthRequest" SET "response" = $1, "responseAccountId" = $2, "updatedAt" = $3 WHERE "id" = $4"#)
            .bind(req.body_str("response").unwrap_or_default())
            .bind(&req.user_id)
            .bind(crate::db::now())
            .bind(&r.id)
            .execute(&app.pool)
            .await
            .map_err(anyhow::Error::from)
            .and_then(crate::db::expect_row)?;
    }
    Reply::json(json!({"success": true}))
}

async fn account_request(app: Arc<App>, req: Req) -> HResult {
    let Some(hex) = box_key(&req.body_str("publicKey").unwrap_or_default())? else {
        return Reply::code(401, json!({"error": "Invalid public key"}));
    };
    let answer = match find_account_request(&app, &hex).await? {
        Some(a) => a,
        None => {
            let now = crate::db::now();
            let id = cuid();
            sqlx::query(r#"INSERT INTO "AccountAuthRequest" ("id","publicKey","createdAt","updatedAt") VALUES ($1,$2,$3,$3)"#)
                .bind(&id)
                .bind(&hex)
                .bind(now)
                .execute(&app.pool)
                .await?;
            AuthRequestRow { id, supports_v2: false, response: None, response_account_id: None }
        }
    };
    if let (Some(resp), Some(acc)) = (answer.response.filter(|s| !s.is_empty()), answer.response_account_id.filter(|s| !s.is_empty())) {
        let token = app.auth.create_token(&acc, None);
        return Reply::json(json!({"state": "authorized", "token": token, "response": resp}));
    }
    Reply::json(json!({"state": "requested"}))
}

async fn account_response(app: Arc<App>, req: Req) -> HResult {
    let Some(hex) = box_key(&req.body_str("publicKey").unwrap_or_default())? else {
        return Reply::code(401, json!({"error": "Invalid public key"}));
    };
    let Some(r) = find_account_request(&app, &hex).await? else {
        return Reply::code(404, json!({"error": "Request not found"}));
    };
    if r.response.as_deref().map_or(true, |s| s.is_empty()) {
        sqlx::query(r#"UPDATE "AccountAuthRequest" SET "response" = $1, "responseAccountId" = $2, "updatedAt" = $3 WHERE "id" = $4"#)
            .bind(req.body_str("response").unwrap_or_default())
            .bind(&req.user_id)
            .bind(crate::db::now())
            .bind(&r.id)
            .execute(&app.pool)
            .await
            .map_err(anyhow::Error::from)
            .and_then(crate::db::expect_row)?;
    }
    Reply::json(json!({"success": true}))
}

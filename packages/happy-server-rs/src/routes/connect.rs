//! `connectRoutes.ts` with `app/github/*` and `modules/github.ts`: GitHub OAuth,
//! webhooks and disconnect, and the encrypted inference-vendor tokens.

use crate::app::App;
use crate::db::{self, expect_row};
use crate::events::{update_account_update, Filter};
use crate::fetch;
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::js;
use crate::util::{cuid, random_key};
use crate::zod::{any, array, boolean, enumeration, literal, object, string};
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::sync::Arc;

const APP_URL: &str = "https://app.happy.engineering";
const VENDORS: &[&str] = &["openai", "anthropic", "gemini"];

pub fn register(r: &mut Router) {
    r.get("/v1/connect/github/params")
        .auth()
        .response(200, object(vec![("url", string())]))
        .response(400, object(vec![("error", string())]))
        .response(500, object(vec![("error", string())]))
        .handle(h!(github_params));

    r.get("/v1/connect/github/callback").query(object(vec![("code", string()), ("state", string())])).handle(h!(github_callback));

    r.post("/v1/connect/github/webhook")
        .headers(object(vec![
            ("x-hub-signature-256", string()),
            ("x-github-event", string()),
            ("x-github-delivery", string().optional()),
        ]))
        .body(any())
        .response(200, object(vec![("received", boolean())]))
        .response(401, object(vec![("error", string())]))
        .response(500, object(vec![("error", string())]))
        .handle(h!(github_webhook));

    r.delete("/v1/connect/github")
        .auth()
        .response(200, object(vec![("success", literal(json!(true)))]))
        .response(404, object(vec![("error", string())]))
        .response(500, object(vec![("error", string())]))
        .handle(h!(github_disconnect_route));

    let vendor = || object(vec![("vendor", enumeration(VENDORS))]);
    r.post("/v1/connect/:vendor/register").auth().body(object(vec![("token", string())])).params(vendor()).handle(h!(vendor_register));
    r.get("/v1/connect/:vendor/token")
        .auth()
        .params(vendor())
        .response(200, object(vec![("token", string().nullable())]))
        .handle(h!(vendor_token));
    r.delete("/v1/connect/:vendor")
        .auth()
        .params(vendor())
        .response(200, object(vec![("success", literal(json!(true)))]))
        .handle(h!(vendor_delete));
    r.get("/v1/connect/tokens")
        .auth()
        .response(200, object(vec![("tokens", array(object(vec![("vendor", string()), ("token", string())])))]))
        .handle(h!(vendor_tokens));
}

// ---------------------------------------------------------------------------
// GitHub OAuth
// ---------------------------------------------------------------------------

async fn github_params(app: Arc<App>, req: Req) -> HResult {
    let (Some(client_id), Some(redirect)) = (&app.config.github_client_id, &app.config.github_redirect_url) else {
        return Reply::error(400, "GitHub OAuth not configured");
    };
    let state = app.auth.create_github_token(&req.user_id);
    let params = [("client_id", client_id.as_str()), ("redirect_uri", redirect), ("scope", "read:user,user:email,read:org,codespace"), ("state", &state)];
    let query: Vec<String> = params.iter().map(|(k, v)| format!("{}={}", k, js::form_urlencode(v))).collect();
    Reply::json(json!({"url": format!("https://github.com/login/oauth/authorize?{}", query.join("&"))}))
}

async fn github_callback(app: Arc<App>, req: Req) -> HResult {
    let code = req.query_field("code").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let state = req.query_field("state").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let Some(user_id) = app.auth.verify_github_token(&state) else {
        tracing::info!(module = "github-oauth", "Invalid state token: {}", state);
        return Reply::redirect(&format!("{}?error=invalid_state", APP_URL));
    };
    let (Some(client_id), Some(secret)) = (&app.config.github_client_id, &app.config.github_client_secret) else {
        return Reply::redirect(&format!("{}?error=server_config", APP_URL));
    };
    match oauth_exchange(&app, &user_id, client_id, secret, &code).await {
        Ok(url) => Reply::redirect(&url),
        Err(e) => {
            tracing::info!(module = "github-oauth", "Error in GitHub GET callback: {:#}", e);
            Reply::redirect(&format!("{}?error=server_error", APP_URL))
        }
    }
}

/// `String(v)` where the TS code would throw a TypeError.
fn string_of(v: Option<&Value>) -> anyhow::Result<String> {
    js::to_string_checked(v).map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))
}

/// The OAuth code exchange through `githubConnect`; returns where to redirect.
async fn oauth_exchange(app: &App, user_id: &str, client_id: &str, secret: &str, code: &str) -> anyhow::Result<String> {
    let body = js::stringify(&json!({"client_id": client_id, "client_secret": secret, "code": code}));
    let resp = fetch::CLIENT
        .post(format!("{}/login/oauth/access_token", app.config.github_oauth_base))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await?;
    let token_data = fetch::json(resp).await?;
    if token_data.is_null() {
        anyhow::bail!("Cannot read properties of null (reading 'error')");
    }
    let error = js::get(Some(&token_data), "error");
    if js::truthy(error) {
        return Ok(format!("{}?error={}", APP_URL, js::encode_uri_component(&string_of(error)?)));
    }
    let access_token = js::get(Some(&token_data), "access_token").cloned();

    let resp = fetch::CLIENT
        .get(format!("{}/user", app.config.github_api_base))
        .header("Authorization", fetch::header_value(&format!("Bearer {}", string_of(access_token.as_ref())?))?)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await?;
    let ok = resp.status().is_success();
    let profile = fetch::json(resp).await?;
    if !ok {
        return Ok(format!("{}?error=github_user_fetch_failed", APP_URL));
    }
    github_connect(app, user_id, &profile, access_token.as_ref()).await?;
    let login = string_of(js::get(Some(&profile), "login"))?;
    Ok(format!("{}?github=connected&user={}", APP_URL, js::encode_uri_component(&login)))
}

/// `separateName`.
fn separate_name(name: Option<&Value>) -> (Value, Value) {
    let Some(Value::String(full)) = name else { return (Value::Null, Value::Null) };
    let trimmed = full.trim_matches(js::is_js_whitespace);
    if trimmed.is_empty() {
        return (Value::Null, Value::Null);
    }
    let parts: Vec<&str> = trimmed.split(js::is_js_whitespace).filter(|p| !p.is_empty()).collect();
    match parts.split_first() {
        Some((first, [])) => (json!(first), Value::Null),
        Some((first, rest)) => (json!(first), json!(rest.join(" "))),
        None => (Value::Null, Value::Null),
    }
}

/// `githubConnect`.
async fn github_connect(app: &App, user_id: &str, profile: &Value, access_token: Option<&Value>) -> anyhow::Result<()> {
    let github_user_id = match js::get(Some(profile), "id") {
        None | Some(Value::Null) => anyhow::bail!("Cannot read properties of undefined (reading 'toString')"),
        id => string_of(id)?,
    };

    let current: Option<(Option<String>,)> =
        sqlx::query_as(r#"SELECT "githubUserId" FROM "Account" WHERE "id" = $1 LIMIT 1"#).bind(user_id).fetch_optional(&app.pool).await?;
    let Some((current,)) = current else { return Err(db::RecordNotFound.into()) };
    if current.as_deref() == Some(github_user_id.as_str()) {
        return Ok(());
    }

    let other: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Account" WHERE "githubUserId" = $1 AND "id" <> $2 LIMIT 1"#)
        .bind(&github_user_id)
        .bind(user_id)
        .fetch_optional(&app.pool)
        .await?;
    if let Some((other,)) = other {
        github_disconnect(app, &other).await?;
    }

    let avatar_url = string_of(js::get(Some(profile), "avatar_url"))?;
    let image = fetch::CLIENT.get(&avatar_url).send().await?.bytes().await?;
    let avatar = upload_image(app, user_id, "avatars", "github", &avatar_url, image.to_vec()).await?;

    let (first_name, last_name) = separate_name(js::get(Some(profile), "name"));
    // Prisma: an undefined `login` leaves `username` alone; anything but a string or
    // null fails validation.
    let login = js::get(Some(profile), "login").cloned();
    if !matches!(login, None | Some(Value::Null) | Some(Value::String(_))) {
        anyhow::bail!("Invalid value for argument `username`: Expected String.");
    }

    let (uid, gid, prof, avatar_json) = (user_id.to_string(), github_user_id.clone(), js::stringify(profile), js::stringify(&avatar));
    let (first, last) = (first_name.as_str().map(str::to_string), last_name.as_str().map(str::to_string));
    let (login_set, login_val) = (login.is_some(), login.as_ref().and_then(|v| v.as_str()).map(str::to_string));
    // privacy-kit only encrypts strings and byte arrays.
    let token = match access_token {
        Some(Value::String(t)) => Some(app.auth.encrypt_string(&["user", user_id, "github", "token"], t)),
        _ => None,
    };
    db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let Some(token) = token else { anyhow::bail!("The \"data\" argument must be a string or Uint8Array") };
            let now = db::now();
            sqlx::query(
                r#"INSERT INTO "GithubUser" ("id","profile","token","createdAt","updatedAt") VALUES ($1,$2::jsonb,$3,$4,$4)
                   ON CONFLICT ("id") DO UPDATE SET "profile" = EXCLUDED."profile", "token" = EXCLUDED."token", "updatedAt" = EXCLUDED."updatedAt""#,
            )
            .bind(&gid)
            .bind(&prof)
            .bind(&token)
            .bind(now)
            .execute(&mut *c)
            .await?;
            let r = sqlx::query(
                r#"UPDATE "Account" SET "githubUserId" = $2, "username" = CASE WHEN $3 THEN $4 ELSE "username" END,
                   "firstName" = $5, "lastName" = $6, "avatar" = $7::jsonb, "updatedAt" = $8 WHERE "id" = $1"#,
            )
            .bind(&uid)
            .bind(&gid)
            .bind(login_set)
            .bind(&login_val)
            .bind(&first)
            .bind(&last)
            .bind(&avatar_json)
            .bind(now)
            .execute(&mut *c)
            .await?;
            expect_row(r)
        })
    })
    .await?;

    let seq = db::allocate_user_seq_pool(&app.pool, user_id).await?;
    let mut with_url = avatar.as_object().cloned().unwrap_or_default();
    let path = with_url.get("path").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    with_url.insert("url".into(), json!(app.files.public_url(&path)));
    let mut fields = vec![("github", profile.clone())];
    if let Some(l) = login {
        fields.push(("username", l));
    }
    fields.push(("firstName", first_name));
    fields.push(("lastName", last_name));
    app.hub.emit_update(user_id, update_account_update(user_id, fields, Some(Value::Object(with_url)), seq), Filter::UserScopedOnly, None);
    Ok(())
}

/// `uploadImage`: reuses any upload of the same source URL that has image info.
async fn upload_image(app: &App, user_id: &str, directory: &str, prefix: &str, url: &str, src: Vec<u8>) -> anyhow::Result<Value> {
    let reuse_key = format!("image-url:{}", url);
    let existing: Option<(String, Option<String>, Option<i32>, Option<i32>)> =
        sqlx::query_as(r#"SELECT "path","thumbhash","width","height" FROM "UploadedFile" WHERE "reuseKey" = $1 LIMIT 1"#)
            .bind(&reuse_key)
            .fetch_optional(&app.pool)
            .await?;
    if let Some((path, Some(thumbhash), Some(width), Some(height))) = existing {
        if !thumbhash.is_empty() && width != 0 && height != 0 {
            return Ok(json!({"path": path, "thumbhash": thumbhash, "width": width, "height": height}));
        }
    }

    let (processed, src) = tokio::task::spawn_blocking(move || (crate::storage::image::process_image(&src), src)).await?;
    let processed = processed?;
    let filename = format!("{}.{}", random_key(prefix), if processed.png { "png" } else { "jpg" });
    let path = format!("public/users/{}/{}/{}", user_id, directory, filename);
    app.files.put(&path, src).await?;
    let now = db::now();
    sqlx::query(
        r#"INSERT INTO "UploadedFile" ("id","accountId","path","reuseKey","width","height","thumbhash","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)"#,
    )
    .bind(cuid())
    .bind(user_id)
    .bind(&path)
    .bind(&reuse_key)
    .bind(processed.width as i32)
    .bind(processed.height as i32)
    .bind(&processed.thumbhash)
    .bind(now)
    .execute(&app.pool)
    .await?;
    Ok(json!({"path": path, "thumbhash": processed.thumbhash, "width": processed.width, "height": processed.height}))
}

/// `githubDisconnect`.
async fn github_disconnect(app: &App, user_id: &str) -> anyhow::Result<()> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as(r#"SELECT "githubUserId" FROM "Account" WHERE "id" = $1"#).bind(user_id).fetch_optional(&app.pool).await?;
    let Some(github_user_id) = row.and_then(|r| r.0).filter(|g| !g.is_empty()) else {
        tracing::info!(module = "github-disconnect", "User {} has no GitHub account connected", user_id);
        return Ok(());
    };
    tracing::info!(module = "github-disconnect", "Disconnecting GitHub account {} from user {}", github_user_id, user_id);
    let (uid, gid) = (user_id.to_string(), github_user_id.clone());
    db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let r = sqlx::query(r#"UPDATE "Account" SET "githubUserId" = NULL, "username" = NULL, "updatedAt" = $2 WHERE "id" = $1"#)
                .bind(&uid)
                .bind(db::now())
                .execute(&mut *c)
                .await?;
            expect_row(r)?;
            let r = sqlx::query(r#"DELETE FROM "GithubUser" WHERE "id" = $1"#).bind(&gid).execute(&mut *c).await?;
            expect_row(r)
        })
    })
    .await?;
    let seq = db::allocate_user_seq_pool(&app.pool, user_id).await?;
    let payload = update_account_update(user_id, vec![("github", Value::Null), ("username", Value::Null)], None, seq);
    app.hub.emit_update(user_id, payload, Filter::UserScopedOnly, None);
    tracing::info!(module = "github-disconnect", "GitHub account {} disconnected successfully from user {}", github_user_id, user_id);
    Ok(())
}

async fn github_disconnect_route(app: Arc<App>, req: Req) -> HResult {
    match github_disconnect(&app, &req.user_id).await {
        Ok(()) => Reply::json(json!({"success": true})),
        Err(e) => {
            tracing::error!(module = "github-disconnect", "{:#}", e);
            Reply::error(500, "Failed to disconnect GitHub account")
        }
    }
}

// ---------------------------------------------------------------------------
// GitHub webhooks (@octokit/webhooks `verifyAndReceive`)
// ---------------------------------------------------------------------------

async fn github_webhook(app: Arc<App>, req: Req) -> HResult {
    // `rawBody` is set by the JSON content-type parser only, and is falsy when empty.
    let media = req.header("content-type").and_then(|c| c.split(';').next()).map(|m| m.trim().to_ascii_lowercase());
    let raw = String::from_utf8_lossy(&req.raw_body).into_owned();
    if media.as_deref() != Some("application/json") || raw.is_empty() {
        tracing::error!(module = "github-webhook", "Raw body not available for webhook signature verification");
        return Reply::error(500, "Server configuration error");
    }
    let Some(secret) = &app.config.github_webhook_secret else {
        tracing::error!(module = "github-webhook", "GitHub webhooks not initialized");
        return Reply::error(500, "Webhooks not configured");
    };
    let headers = crate::http::node_headers(&req.headers);
    let header = |k: &str| headers.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let (signature, name) = (header("x-hub-signature-256"), header("x-github-event"));

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(raw.as_bytes());
    let expected = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    if signature.is_empty() || signature != expected {
        return Reply::error(500, "Internal server error");
    }
    // `JSON.parse(rawBody)` again: a whitespace-only body parsed as `{}` fails here.
    let Ok(payload) = js::parse(&raw) else { return Reply::error(500, "Internal server error") };
    if name.is_empty() || !js::truthy(Some(&payload)) {
        return Reply::error(500, "Internal server error"); // "Event name not passed"
    }
    match receive(&name, &payload) {
        Ok(()) => Reply::json(json!({"received": true})),
        Err(()) => Reply::error(500, "Internal server error"),
    }
}

/// Runs the hooks `modules/github.ts` registers; `Err` if any of them throws.
fn receive(name: &str, payload: &Value) -> Result<(), ()> {
    // `"action" in payload` throws for primitives.
    let action = match payload {
        Value::Object(m) => m.get("action"),
        Value::Array(_) => None,
        _ => return Err(()),
    };
    let mut hooks = vec![];
    if js::truthy(action) {
        hooks.push(format!("{}.{}", name, js::to_string_checked(action)?));
    }
    hooks.push(name.to_string());

    let p = Some(payload);
    // `a.b` throws when `a` is null or undefined; a template literal throws when
    // the value cannot become a string.
    let obj = |k: &str| -> Result<Option<&Value>, ()> {
        match js::get(p, k) {
            None | Some(Value::Null) => Err(()),
            v => Ok(v),
        }
    };
    let text = |v: Option<&Value>| js::to_string_checked(v).map(|_| ());
    let mut failed = false;
    for hook in &hooks {
        let r = match hook.as_str() {
            "push" => (|| {
                text(js::get(obj("repository")?, "full_name"))?;
                text(js::get(obj("pusher")?, "name"))
            })(),
            "pull_request" => (|| {
                text(js::get(p, "action"))?;
                text(js::get(obj("repository")?, "full_name"))?;
                let pr = obj("pull_request")?;
                text(js::get(pr, "number"))?;
                text(js::get(pr, "title"))
            })(),
            "issues" => (|| {
                text(js::get(p, "action"))?;
                text(js::get(obj("repository")?, "full_name"))?;
                let issue = obj("issue")?;
                text(js::get(issue, "number"))?;
                text(js::get(issue, "title"))
            })(),
            "star.created" | "star.deleted" => (|| {
                text(js::get(obj("repository")?, "full_name"))?;
                text(js::get(obj("sender")?, "login"))
            })(),
            "repository" => (|| {
                text(js::get(p, "action"))?;
                text(js::get(obj("repository")?, "full_name"))
            })(),
            _ => Ok(()),
        };
        failed |= r.is_err();
    }
    tracing::info!(module = "github-webhook", event = name, "Received webhook event: {}", name);
    if failed {
        tracing::error!(module = "github-webhook", "Webhook handler error: {}", name);
        return Err(());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Inference vendor tokens
// ---------------------------------------------------------------------------

async fn vendor_register(app: Arc<App>, req: Req) -> HResult {
    let (uid, vendor) = (req.user_id.clone(), req.param("vendor"));
    let token = app.auth.encrypt_string(&["user", &uid, "vendors", &vendor, "token"], &req.body_str("token").unwrap_or_default());
    let now = db::now();
    sqlx::query(
        r#"INSERT INTO "ServiceAccountToken" ("id","accountId","vendor","token","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$5)
           ON CONFLICT ("accountId","vendor") DO UPDATE SET "token" = EXCLUDED."token", "updatedAt" = EXCLUDED."updatedAt""#,
    )
    .bind(cuid())
    .bind(&uid)
    .bind(&vendor)
    .bind(&token)
    .bind(now)
    .execute(&app.pool)
    .await?;
    Reply::json(json!({"success": true}))
}

async fn vendor_token(app: Arc<App>, req: Req) -> HResult {
    let (uid, vendor) = (req.user_id.clone(), req.param("vendor"));
    let row: Option<(Vec<u8>,)> = sqlx::query_as(r#"SELECT "token" FROM "ServiceAccountToken" WHERE "accountId" = $1 AND "vendor" = $2"#)
        .bind(&uid)
        .bind(&vendor)
        .fetch_optional(&app.pool)
        .await?;
    match row {
        None => Reply::json(json!({"token": null})),
        Some((t,)) => Reply::json(json!({"token": app.auth.decrypt_string(&["user", &uid, "vendors", &vendor, "token"], &t)?})),
    }
}

async fn vendor_delete(app: Arc<App>, req: Req) -> HResult {
    let r = sqlx::query(r#"DELETE FROM "ServiceAccountToken" WHERE "accountId" = $1 AND "vendor" = $2"#)
        .bind(&req.user_id)
        .bind(req.param("vendor"))
        .execute(&app.pool)
        .await?;
    expect_row(r)?;
    Reply::json(json!({"success": true}))
}

async fn vendor_tokens(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let rows: Vec<(String, Vec<u8>)> =
        sqlx::query_as(r#"SELECT "vendor","token" FROM "ServiceAccountToken" WHERE "accountId" = $1"#).bind(&uid).fetch_all(&app.pool).await?;
    let mut tokens = Vec::new();
    for (vendor, t) in rows {
        let token = app.auth.decrypt_string(&["user", &uid, "vendors", &vendor, "token"], &t)?;
        let mut m = Map::new();
        m.insert("vendor".into(), json!(vendor));
        m.insert("token".into(), json!(token));
        tokens.push(Value::Object(m));
    }
    Reply::json(json!({"tokens": tokens}))
}

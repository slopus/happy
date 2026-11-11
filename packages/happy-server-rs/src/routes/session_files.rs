//! `sessionAvatarRoutes.ts` (opaque encrypted session artwork) and
//! `attachmentRoutes.ts` (encrypted chat attachments, no database records).

use super::projects::is_uuid_enc;
use super::uploads::{base_url, buffer_body, MAX_FILE_SIZE, PRESIGNED_TTL_SECONDS};
use crate::app::App;
use crate::events::{self, Filter, SessionUpdate};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::util::{now_ms, uuid_v4};
use crate::zod::{enumeration, number, object, record, string, S};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::sync::Arc;

fn avatar_params() -> S {
    object(vec![("sessionId", string().regex("/^[a-zA-Z0-9_-]+$/").max(256.0))])
}

fn avatar_file_params() -> S {
    object(vec![
        ("sessionId", string().regex("/^[a-zA-Z0-9_-]+$/").max(256.0)),
        ("avatarFile", string().regex("/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.enc$/i")),
    ])
}

fn err_schema() -> S {
    object(vec![("error", string())])
}

pub fn register(r: &mut Router) {
    // sessionAvatarRoutes.ts
    r.post("/v1/sessions/:sessionId/avatar/request-upload")
        .auth()
        .params(avatar_params())
        .body(object(vec![("size", number().int().min(1.0).max(MAX_FILE_SIZE as f64))]))
        .handle(h!(avatar_request_upload));
    r.put("/v1/sessions/:sessionId/avatar/:avatarFile")
        .auth()
        .body_limit(MAX_FILE_SIZE)
        .params(avatar_file_params())
        .handle(h!(avatar_upload));
    r.patch("/v1/sessions/:sessionId/avatar")
        .auth()
        .params(avatar_params())
        .body(object(vec![("ref", string().min(1.0).max(1024.0)), ("preview", string().min(1.0).max(4096.0))]).strict())
        .handle(h!(avatar_activate));
    r.delete("/v1/sessions/:sessionId/avatar").auth().params(avatar_params()).handle(h!(avatar_delete));
    r.post("/v1/sessions/:sessionId/avatar/request-download").auth().params(avatar_params()).handle(h!(avatar_request_download));
    r.get("/v1/sessions/:sessionId/avatar/:avatarFile").auth().params(avatar_file_params()).handle(h!(avatar_download));

    // attachmentRoutes.ts
    r.post("/v1/sessions/:sessionId/attachments/request-upload")
        .params(object(vec![("sessionId", string())]))
        .body(object(vec![("filename", string()), ("size", number().max(MAX_FILE_SIZE as f64))]))
        .response(
            200,
            object(vec![
                ("ref", string()),
                ("uploadUrl", string()),
                ("method", enumeration(&["PUT", "POST"])),
                ("formFields", record().optional()),
            ]),
        )
        .response(404, err_schema())
        .response(413, err_schema())
        .response(429, err_schema())
        .auth()
        .handle(h!(attachment_request_upload));
    r.put("/v1/sessions/:sessionId/attachments/:attachmentFile")
        .params(object(vec![("sessionId", string()), ("attachmentFile", string())]))
        .response(200, object(vec![("ok", crate::zod::boolean())]))
        .response(404, err_schema())
        .response(413, err_schema())
        .auth()
        .handle(h!(attachment_upload));
    r.post("/v1/sessions/:sessionId/attachments/request-download")
        .params(object(vec![("sessionId", string())]))
        .body(object(vec![("ref", string())]))
        .response(200, object(vec![("downloadUrl", string())]))
        .response(400, err_schema())
        .response(404, err_schema())
        .auth()
        .handle(h!(attachment_request_download));
    r.get("/v1/sessions/:sessionId/attachments/:attachmentFile")
        .params(object(vec![("sessionId", string()), ("attachmentFile", string())]))
        .auth()
        .handle(h!(attachment_download));
}

struct Owned {
    avatar_ref: Option<String>,
    avatar_preview: Option<String>,
    avatar_version: i32,
}

async fn owned(app: &App, id: &str, uid: &str) -> anyhow::Result<Option<Owned>> {
    let r: Option<(Option<String>, Option<String>, i32)> =
        sqlx::query_as(r#"SELECT "avatarRef","avatarPreview","avatarVersion" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
            .bind(id)
            .bind(uid)
            .fetch_optional(&app.pool)
            .await?;
    Ok(r.map(|(a, p, v)| Owned { avatar_ref: a, avatar_preview: p, avatar_version: v }))
}

fn session_not_found() -> HResult {
    Reply::error(404, "Session not found")
}

// ---------------------------------------------------------------------------
// Session avatars
// ---------------------------------------------------------------------------

fn valid_avatar_ref(id: &str, r: &str) -> bool {
    r.strip_prefix(&format!("sessions/{}/avatar/", id)).is_some_and(is_uuid_enc)
}

/// The route's limiter: entries older than a minute are swept on every request, at
/// most 60 per user per window, and new users are refused once 10 000 are tracked.
static AVATAR_LIMITS: LazyLock<parking_lot::Mutex<indexmap::IndexMap<String, (i64, u32)>>> = LazyLock::new(Default::default);

fn avatar_rate_ok(uid: &str) -> bool {
    let now = now_ms();
    let mut m = AVATAR_LIMITS.lock();
    m.retain(|_, (at, _)| now - *at < 60_000);
    let present = m.contains_key(uid);
    let (at, count) = m.get(uid).copied().unwrap_or((now, 0));
    if count >= 60 || (!present && m.len() >= 10_000) {
        return false;
    }
    m.insert(uid.to_string(), (at, count + 1));
    true
}

async fn avatar_request_upload(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("sessionId");
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    if !avatar_rate_ok(&req.user_id) {
        return Reply::error(429, "Too many avatar uploads. Try again later.");
    }
    let file = format!("{}.enc", uuid_v4());
    let r = format!("sessions/{}/avatar/{}", id, file);
    match &app.files.s3 {
        None => Reply::json(json!({ "ref": r, "method": "PUT", "uploadUrl": format!("{}/v1/sessions/{}/avatar/{}", base_url(&app, &req), id, file) })),
        Some(s3) => {
            let (url, fields) = s3.presigned_post(&app.files.bucket, &r, now_ms() + 15 * 60_000, 1, MAX_FILE_SIZE as u64);
            Reply::json(json!({ "ref": r, "method": "POST", "uploadUrl": url, "formFields": fields }))
        }
    }
}

async fn avatar_upload(app: Arc<App>, req: Req) -> HResult {
    if !app.files.is_local() {
        return Reply::error(404, "Direct upload is unavailable");
    }
    let (id, file) = (req.param("sessionId"), req.param("avatarFile"));
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    let Some(bytes) = buffer_body(&req).filter(|b| !b.is_empty() && b.len() <= MAX_FILE_SIZE) else {
        return Reply::error(413, "Avatar must contain at most 10 MB of encrypted image data");
    };
    let target = app.files.local_path(&format!("sessions/{}/avatar/{}", id, file));
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Activated references are immutable: `writeFile(…, { flag: 'wx' })`.
    let created = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&target).await;
    match created {
        Ok(mut f) => {
            use tokio::io::AsyncWriteExt;
            f.write_all(bytes).await?;
            f.flush().await?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if tokio::fs::read(&target).await? != bytes {
                return Reply::error(409, "Avatar upload already exists");
            }
        }
        Err(e) => return Err(e.into()),
    }
    Reply::json(json!({"ok": true}))
}

async fn avatar_activate(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("sessionId");
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    let r = req.body_str("ref").unwrap_or_default();
    let preview = req.body_str("preview").unwrap_or_default();
    if !valid_avatar_ref(&id, &r) {
        return Reply::error(400, "Invalid session avatar reference");
    }
    let size: Option<u64> = match &app.files.s3 {
        None => tokio::fs::metadata(app.files.local_path(&r)).await.ok().map(|m| m.len()),
        Some(_) => app.files.stat(&r).await.ok().map(|s| s.size),
    };
    match size {
        None => return Reply::error(404, "Avatar upload not found"),
        Some(n) if n < 1 || n > MAX_FILE_SIZE as u64 => return Reply::error(413, "Avatar image is too large or empty"),
        _ => {}
    }
    match mutate(&app, &id, &req.user_id, Some((r, preview))).await? {
        Some(avatar) => Reply::json(json!({ "avatar": avatar })),
        None => session_not_found(),
    }
}

async fn avatar_delete(app: Arc<App>, req: Req) -> HResult {
    match mutate(&app, &req.param("sessionId"), &req.user_id, None).await? {
        Some(avatar) => Reply::json(json!({ "avatar": avatar })),
        None => session_not_found(),
    }
}

/// Sets or clears the descriptor and takes a user seq in one transaction; the
/// update is published only when something changed.
async fn mutate(app: &App, id: &str, uid: &str, next: Option<(String, String)>) -> anyhow::Result<Option<Value>> {
    let (i, u, n) = (id.to_string(), uid.to_string(), next.clone());
    let result = crate::db::in_tx(&app.pool, move |c| {
        let (i, u, n) = (i.clone(), u.clone(), n.clone());
        Box::pin(async move {
            let cur: Option<(Option<String>, Option<String>, i32)> = sqlx::query_as(
                r#"SELECT "avatarRef","avatarPreview","avatarVersion" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#,
            )
            .bind(&i)
            .bind(&u)
            .fetch_optional(&mut *c)
            .await?;
            let Some((r, p, v)) = cur else { return Ok(None) };
            let (nr, np) = match &n {
                Some((a, b)) => (Some(a.clone()), Some(b.clone())),
                None => (None, None),
            };
            if r == nr && p == np {
                return Ok(Some((events::session_avatar(&r, &p, v), None)));
            }
            let (r2, p2, v2): (Option<String>, Option<String>, i32) = sqlx::query_as(
                r#"UPDATE "Session" SET "avatarRef" = $2, "avatarPreview" = $3, "avatarVersion" = "avatarVersion" + 1, "updatedAt" = $4
                   WHERE "id" = $1 RETURNING "avatarRef","avatarPreview","avatarVersion""#,
            )
            .bind(&i)
            .bind(&nr)
            .bind(&np)
            .bind(crate::db::now())
            .fetch_optional(&mut *c)
            .await?
            .ok_or(crate::db::RecordNotFound)?;
            let seq = crate::db::allocate_user_seq(c, &u).await?;
            Ok(Some((events::session_avatar(&r2, &p2, v2), Some((seq, v2)))))
        })
    })
    .await?;
    let Some((avatar, changed)) = result else { return Ok(None) };
    if let Some((seq, version)) = changed {
        let u = SessionUpdate { metadata: None, agent_state: None, project_id: None, avatar: Some(avatar.clone()), avatar_version: Some(version) };
        app.hub.emit_update(uid, events::update_session_update(id, seq, u), Filter::Session(id), None);
    }
    Ok(Some(avatar))
}

async fn avatar_request_download(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("sessionId");
    let session = owned(&app, &id, &req.user_id).await?;
    let r = match session.and_then(|s| s.avatar_ref) {
        Some(r) if !r.is_empty() && valid_avatar_ref(&id, &r) => r,
        _ => return Reply::error(404, "Session avatar not found"),
    };
    let url = match &app.files.s3 {
        None => format!("{}/v1/sessions/{}/avatar/{}", base_url(&app, &req), id, &r[r.rfind('/').map(|i| i + 1).unwrap_or(0)..]),
        Some(s3) => s3.presigned_get(&app.files.bucket, &r, PRESIGNED_TTL_SECONDS),
    };
    Reply::json(json!({ "ref": r, "downloadUrl": url }))
}

async fn avatar_download(app: Arc<App>, req: Req) -> HResult {
    if !app.files.is_local() {
        return Reply::error(404, "Direct download is unavailable");
    }
    let id = req.param("sessionId");
    let r = format!("sessions/{}/avatar/{}", id, req.param("avatarFile"));
    let session = owned(&app, &id, &req.user_id).await?;
    if session.and_then(|s| s.avatar_ref).as_deref() != Some(r.as_str()) {
        return Reply::error(404, "Session avatar not found");
    }
    match tokio::fs::read(app.files.local_path(&r)).await {
        Ok(b) => Ok(Reply::bytes(b)?.with_header("cache-control", "private, no-store")),
        Err(_) => Reply::error(404, "Session avatar not found"),
    }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/// Per-user fixed one-minute window, 60 requests; a separate map from projects'.
static ATTACHMENT_RATE: LazyLock<DashMap<String, (u32, i64)>> = LazyLock::new(DashMap::new);

fn attachment_rate_ok(uid: &str) -> bool {
    let now = now_ms();
    {
        let mut e = ATTACHMENT_RATE.entry(uid.to_string()).or_insert((0, now));
        if !(e.0 == 0 || now - e.1 >= 60_000) {
            if e.0 >= 60 {
                return false;
            }
            e.0 += 1;
            return true;
        }
        *e = (1, now);
    }
    if ATTACHMENT_RATE.len() > 10_000 {
        ATTACHMENT_RATE.retain(|_, (_, at)| now - *at < 60_000);
    }
    true
}

async fn attachment_request_upload(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("sessionId");
    if !attachment_rate_ok(&req.user_id) {
        return Reply::error(429, "Too many upload requests. Try again in a minute.");
    }
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    let file = format!("{}.enc", uuid_v4());
    let r = format!("sessions/{}/attachments/{}", id, file);
    match &app.files.s3 {
        None => Reply::json(json!({ "ref": r, "uploadUrl": format!("{}/v1/sessions/{}/attachments/{}", base_url(&app, &req), id, file), "method": "PUT" })),
        Some(s3) => {
            let expires = now_ms() + PRESIGNED_TTL_SECONDS as i64 * 1000;
            let (url, fields) = s3.presigned_post(&app.files.bucket, &r, expires, 0, MAX_FILE_SIZE as u64);
            Reply::json(json!({ "ref": r, "uploadUrl": url, "method": "POST", "formFields": fields }))
        }
    }
}

fn bad_file(f: &str) -> bool {
    f.contains("..") || f.contains('/')
}

async fn attachment_upload(app: Arc<App>, req: Req) -> HResult {
    if !app.files.is_local() {
        return Reply::error(404, "Direct upload not available in S3 mode");
    }
    let (id, file) = (req.param("sessionId"), req.param("attachmentFile"));
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    if bad_file(&file) {
        return Reply::error(404, "Invalid attachment file");
    }
    // `request.body as Buffer`: a Buffer or a string is written; anything else makes
    // `.length` or `writeFileSync` throw (uncaught 500).
    let data: Vec<u8> = match (buffer_body(&req), &req.body) {
        (Some(b), _) => {
            if b.len() > MAX_FILE_SIZE {
                return Reply::error(413, "File too large (max 10MB)");
            }
            b.to_vec()
        }
        (None, Some(Value::String(s))) => {
            if s.encode_utf16().count() > MAX_FILE_SIZE {
                return Reply::error(413, "File too large (max 10MB)");
            }
            s.as_bytes().to_vec()
        }
        _ => anyhow::bail!("TypeError: The \"data\" argument must be of type string or an instance of Buffer"),
    };
    app.files.put_local(&format!("sessions/{}/attachments/{}", id, file), &data).await?;
    Reply::json(json!({"ok": true}))
}

async fn attachment_request_download(app: Arc<App>, req: Req) -> HResult {
    let id = req.param("sessionId");
    let r = req.body_str("ref").unwrap_or_default();
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    let prefix = format!("sessions/{}/attachments/", id);
    let Some(file) = r.strip_prefix(&prefix) else {
        return Reply::error(400, "Ref does not belong to this session");
    };
    if file.is_empty() || bad_file(file) {
        return Reply::error(400, "Invalid attachment ref");
    }
    let url = match &app.files.s3 {
        None => format!("{}/v1/sessions/{}/attachments/{}", base_url(&app, &req), id, file),
        Some(s3) => s3.presigned_get(&app.files.bucket, &r, PRESIGNED_TTL_SECONDS),
    };
    Reply::json(json!({ "downloadUrl": url }))
}

async fn attachment_download(app: Arc<App>, req: Req) -> HResult {
    let (id, file) = (req.param("sessionId"), req.param("attachmentFile"));
    if owned(&app, &id, &req.user_id).await?.is_none() {
        return session_not_found();
    }
    if bad_file(&file) {
        return Reply::error(404, "Invalid attachment file");
    }
    let r = format!("sessions/{}/attachments/{}", id, file);
    match &app.files.s3 {
        None => {
            let full = app.files.local_path(&r);
            if tokio::fs::metadata(&full).await.is_err() {
                return Reply::error(404, "Attachment not found");
            }
            // `fs.readFileSync` on a directory throws: an uncaught 500.
            Reply::bytes(tokio::fs::read(&full).await?)
        }
        Some(s3) => Reply::redirect(&s3.presigned_get(&app.files.bucket, &r, PRESIGNED_TTL_SECONDS)),
    }
}

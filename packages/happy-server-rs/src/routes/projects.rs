//! `projectRoutes.ts`: encrypted project catalog and avatar transport.

use super::uploads::{base_url, buffer_body, MAX_FILE_SIZE, PRESIGNED_TTL_SECONDS};
use crate::app::App;
use crate::events::{self, Filter, SessionUpdate};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::models::{Project, PROJECT_COLS};
use crate::util::{cuid, now_ms, stablelib_b64_decode, uuid_v4};
use crate::zod::{coerce_number, number, object, string, S};
use anyhow::anyhow;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

const MAX_METADATA_SIZE: f64 = 4.0 * 1024.0 * 1024.0;

fn project_params() -> S {
    object(vec![("projectId", string().min(1.0))])
}

fn file_params() -> S {
    object(vec![("projectId", string().min(1.0)), ("avatarFile", string())])
}

pub fn register(r: &mut Router) {
    r.post("/v1/projects")
        .auth()
        .body(object(vec![
            ("externalId", string().min(1.0).max(512.0)),
            ("metadata", string().min(1.0).max(MAX_METADATA_SIZE)),
            ("dataEncryptionKey", string().nullish()),
        ]))
        .handle(h!(create));

    r.get("/v1/projects")
        .auth()
        .query(
            object(vec![("changedSince", coerce_number().int().positive().optional()), ("ids", string().min(1.0).max(32_768.0).optional())])
                .optional(),
        )
        .handle(h!(list));

    r.get("/v1/projects/:projectId").auth().params(project_params()).handle(h!(get));

    r.patch("/v1/projects/:projectId")
        .auth()
        .params(project_params())
        .body(
            object(vec![
                ("metadata", string().min(1.0).max(MAX_METADATA_SIZE).optional()),
                ("expectedMetadataVersion", number().int().min(0.0).optional()),
            ])
            .strict(),
        )
        .handle(h!(patch));

    r.patch("/v1/projects/:projectId/avatar")
        .auth()
        .params(project_params())
        .body(object(vec![("ref", string().min(1.0).max(1024.0)), ("preview", string().min(1.0).max(MAX_METADATA_SIZE))]))
        .handle(h!(avatar_activate));

    r.delete("/v1/projects/:projectId/avatar").auth().params(project_params()).handle(h!(avatar_delete));

    r.delete("/v1/projects/:projectId").auth().params(project_params()).handle(h!(delete));

    r.post("/v1/projects/:projectId/avatar/request-upload")
        .auth()
        .params(project_params())
        .body(object(vec![("size", number().int().min(0.0).max(MAX_FILE_SIZE as f64))]))
        .handle(h!(request_upload));

    r.put("/v1/projects/:projectId/avatar/:avatarFile").auth().params(file_params()).handle(h!(upload));

    r.post("/v1/projects/:projectId/avatar/request-download").auth().params(project_params()).handle(h!(request_download));

    r.get("/v1/projects/:projectId/avatar/:avatarFile").auth().params(file_params()).handle(h!(download));
}

async fn find(app: &App, id: &str, uid: &str) -> anyhow::Result<Option<Project>> {
    let row = sqlx::query(&format!(r#"SELECT {} FROM "Project" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#, PROJECT_COLS))
        .bind(id)
        .bind(uid)
        .fetch_optional(&app.pool)
        .await?;
    Ok(row.as_ref().map(Project::from_row))
}

async fn find_by_external(app: &App, uid: &str, external: &str) -> anyhow::Result<Option<Project>> {
    let row = sqlx::query(&format!(r#"SELECT {} FROM "Project" WHERE "accountId" = $1 AND "externalId" = $2 LIMIT 1"#, PROJECT_COLS))
        .bind(uid)
        .bind(external)
        .fetch_optional(&app.pool)
        .await?;
    Ok(row.as_ref().map(Project::from_row))
}

fn not_found() -> HResult {
    Reply::error(404, "Project not found")
}

async fn emit(app: &App, uid: &str, t: &str, project_id: &str) -> anyhow::Result<()> {
    let seq = crate::db::allocate_user_seq_pool(&app.pool, uid).await?;
    app.hub.emit_update(uid, events::simple_update(seq, t, "projectId", project_id), Filter::UserScopedOnly, None);
    Ok(())
}

/// `projectAvatarRef`: `projects/<id>/avatar/<uuid v4>.enc` (case-insensitive hex).
fn valid_ref(project_id: &str, r: &str) -> bool {
    let prefix = format!("projects/{}/avatar/", project_id);
    match r.strip_prefix(&prefix) {
        Some(file) => is_uuid_enc(file),
        None => false,
    }
}

pub fn is_uuid_enc(file: &str) -> bool {
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$").unwrap());
    RE.is_match(file)
}

/// `localProjectAvatarPath`: `path.resolve(baseDir, ref)` must stay inside the files dir.
fn local_avatar_path(app: &App, project_id: &str, r: &str) -> Option<PathBuf> {
    if !valid_ref(project_id, r) {
        return None;
    }
    let base = absolute(app.files.local_dir());
    let full = crate::storage::files::normalize_join(&base, r);
    (full.starts_with(&base) && full != base).then_some(full)
}

fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        crate::storage::files::normalize_join(Path::new("/"), &p.to_string_lossy())
    } else {
        crate::storage::files::normalize_join(&std::env::current_dir().unwrap_or_default(), &p.to_string_lossy())
    }
}

async fn create(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    let external = req.body_str("externalId").unwrap_or_default();
    if let Some(p) = find_by_external(&app, &uid, &external).await? {
        return Reply::json(p.json());
    }
    // `decodeDataKey`: undefined stays unset (NULL), null is NULL, a string is decoded (throws).
    let dek = match req.body_field("dataEncryptionKey") {
        Some(Value::String(s)) => Some(stablelib_b64_decode(s).map_err(|e| anyhow!(e))?),
        _ => None,
    };
    let now = crate::db::now();
    let created = sqlx::query(&format!(
        r#"INSERT INTO "Project" ("id","accountId","externalId","metadata","metadataVersion","dataEncryptionKey","avatarVersion","seq","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,1,$5,0,0,$6,$6) RETURNING {}"#,
        PROJECT_COLS
    ))
    .bind(cuid())
    .bind(&uid)
    .bind(&external)
    .bind(req.body_str("metadata").unwrap_or_default())
    .bind(dek)
    .bind(now)
    .fetch_one(&app.pool)
    .await
    .map_err(anyhow::Error::from);
    let project = match created {
        Ok(row) => Project::from_row(&row),
        Err(e) if crate::db::is_unique_violation(&e) => {
            // A concurrent retry won the (accountId, externalId) insert: load it.
            return match find_by_external(&app, &uid, &external).await? {
                Some(p) => Reply::json(p.json()),
                None => Err(e),
            };
        }
        Err(e) => return Err(e),
    };
    emit(&app, &uid, "new-project", &project.id).await?;
    Reply::json(project.json())
}

async fn list(app: Arc<App>, req: Req) -> HResult {
    // `query.ids ? [...new Set(ids.split(','))] : undefined`
    let ids: Option<Vec<String>> = req.query_field("ids").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| {
        let mut out: Vec<String> = Vec::new();
        for id in s.split(',') {
            if !out.iter().any(|x| x == id) {
                out.push(id.to_string());
            }
        }
        out
    });
    if let Some(ids) = &ids {
        if ids.len() > 100 || ids.iter().any(|id| id.is_empty() || id.encode_utf16().count() > 256) {
            return Reply::error(400, "Invalid project ids");
        }
    }
    let changed = req.query_field("changedSince").and_then(|v| v.as_f64()).filter(|n| *n != 0.0).map(super::js_date_ms).transpose()?;
    let rows = sqlx::query(&format!(
        r#"SELECT {} FROM "Project" WHERE "accountId" = $1 AND ($2::text[] IS NULL OR "id" = ANY($2)) AND ($3::timestamp IS NULL OR "updatedAt" > $3)
           ORDER BY "updatedAt" DESC"#,
        PROJECT_COLS
    ))
    .bind(&req.user_id)
    .bind(&ids)
    .bind(changed)
    .fetch_all(&app.pool)
    .await?;
    Reply::json(json!({ "projects": rows.iter().map(|r| Project::from_row(r).json()).collect::<Vec<_>>() }))
}

async fn get(app: Arc<App>, req: Req) -> HResult {
    match find(&app, &req.param("projectId"), &req.user_id).await? {
        Some(p) => Reply::json(p.json()),
        None => not_found(),
    }
}

async fn patch(app: Arc<App>, req: Req) -> HResult {
    let (uid, id) = (req.user_id.clone(), req.param("projectId"));
    let Some(current) = find(&app, &id, &uid).await? else { return not_found() };
    let expected = req.body_field("expectedMetadataVersion").and_then(|v| v.as_f64());
    if let Some(e) = expected {
        if e != current.metadata_version as f64 {
            return Reply::code(409, json!({ "error": "Project metadata version mismatch", "project": current.json() }));
        }
    }
    let metadata = match req.body_str("metadata") {
        Some(m) if m != current.metadata => m,
        _ => return Reply::json(current.json()),
    };
    let row = sqlx::query(&format!(
        r#"UPDATE "Project" SET "metadata" = $1, "metadataVersion" = "metadataVersion" + 1, "seq" = "seq" + 1, "updatedAt" = $2
           WHERE "id" = $3 AND ($4::int IS NULL OR "metadataVersion" = $4) RETURNING {}"#,
        PROJECT_COLS
    ))
    .bind(&metadata)
    .bind(crate::db::now())
    .bind(&id)
    .bind(expected.map(|e| e as i32))
    .fetch_optional(&app.pool)
    .await?;
    let project = match row {
        Some(r) => Project::from_row(&r),
        None if expected.is_some() => {
            let latest = find(&app, &id, &uid).await?;
            return Reply::code(409, json!({ "error": "Project metadata version mismatch", "project": latest.map(|p| p.json()) }));
        }
        None => return Err(crate::db::RecordNotFound.into()),
    };
    emit(&app, &uid, "update-project", &id).await?;
    Reply::json(project.json())
}

async fn avatar_activate(app: Arc<App>, req: Req) -> HResult {
    let (uid, id) = (req.user_id.clone(), req.param("projectId"));
    let Some(current) = find(&app, &id, &uid).await? else { return not_found() };
    let r = req.body_str("ref").unwrap_or_default();
    let preview = req.body_str("preview").unwrap_or_default();
    if !valid_ref(&id, &r) {
        return Reply::error(400, "Invalid project avatar ref");
    }
    let present = if app.files.is_local() {
        // `fs.existsSync`: directories count.
        match local_avatar_path(&app, &id, &r) {
            Some(p) => tokio::fs::metadata(&p).await.is_ok(),
            None => false,
        }
    } else {
        app.files.stat(&r).await.is_ok()
    };
    if !present {
        return Reply::error(404, "Project avatar upload not found");
    }
    if current.avatar_ref.as_deref() == Some(r.as_str()) && current.avatar_preview.as_deref() == Some(preview.as_str()) {
        return Reply::json(current.json());
    }
    let project = update_avatar(&app, &id, Some((&r, &preview))).await?;
    emit(&app, &uid, "update-project", &id).await?;
    Reply::json(project.json())
}

async fn update_avatar(app: &App, id: &str, next: Option<(&str, &str)>) -> anyhow::Result<Project> {
    let row = sqlx::query(&format!(
        r#"UPDATE "Project" SET "avatarRef" = $1, "avatarPreview" = $2, "avatarVersion" = "avatarVersion" + 1, "seq" = "seq" + 1, "updatedAt" = $3
           WHERE "id" = $4 RETURNING {}"#,
        PROJECT_COLS
    ))
    .bind(next.map(|n| n.0))
    .bind(next.map(|n| n.1))
    .bind(crate::db::now())
    .bind(id)
    .fetch_optional(&app.pool)
    .await?
    .ok_or(crate::db::RecordNotFound)?;
    Ok(Project::from_row(&row))
}

async fn avatar_delete(app: Arc<App>, req: Req) -> HResult {
    let (uid, id) = (req.user_id.clone(), req.param("projectId"));
    let Some(current) = find(&app, &id, &uid).await? else { return not_found() };
    // `!avatarRef && !avatarPreview`: empty strings count as absent.
    if current.avatar_ref.as_deref().unwrap_or("").is_empty() && current.avatar_preview.as_deref().unwrap_or("").is_empty() {
        return Reply::json(current.json());
    }
    let project = update_avatar(&app, &id, None).await?;
    emit(&app, &uid, "update-project", &id).await?;
    let _ = app.files.delete_project_avatars(&id).await;
    Reply::json(project.json())
}

async fn delete(app: Arc<App>, req: Req) -> HResult {
    let (uid, id) = (req.user_id.clone(), req.param("projectId"));
    let (u, p) = (uid.clone(), id.clone());
    let linked = crate::db::in_tx(&app.pool, move |c| {
        let (u, p) = (u.clone(), p.clone());
        Box::pin(async move {
            let found: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Project" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
                .bind(&p)
                .bind(&u)
                .fetch_optional(&mut *c)
                .await?;
            if found.is_none() {
                return Ok(None);
            }
            let sessions: Vec<String> = sqlx::query_scalar(r#"SELECT "id" FROM "Session" WHERE "projectId" = $1"#).bind(&p).fetch_all(&mut *c).await?;
            sqlx::query(r#"UPDATE "Session" SET "projectId" = NULL, "updatedAt" = $2 WHERE "projectId" = $1"#)
                .bind(&p)
                .bind(crate::db::now())
                .execute(&mut *c)
                .await?;
            crate::db::expect_row(sqlx::query(r#"DELETE FROM "Project" WHERE "id" = $1"#).bind(&p).execute(&mut *c).await?)?;
            Ok(Some(sessions))
        })
    })
    .await?;
    let Some(sessions) = linked else { return not_found() };
    // afterTx: not awaited by the response.
    let app2 = app.clone();
    tokio::spawn(async move {
        let r: anyhow::Result<()> = async {
            for sid in sessions {
                let seq = crate::db::allocate_user_seq_pool(&app2.pool, &uid).await?;
                let u = SessionUpdate { metadata: None, agent_state: None, project_id: Some(Value::Null), avatar: None, avatar_version: None };
                app2.hub.emit_update(&uid, events::update_session_update(&sid, seq, u), Filter::UserScopedOnly, None);
            }
            emit(&app2, &uid, "delete-project", &id).await?;
            let _ = app2.files.delete_project_avatars(&id).await;
            Ok(())
        }
        .await;
        if let Err(e) = r {
            // TS: an unhandled rejection here terminates the process.
            tracing::error!(module = "projects", "delete-project updates failed: {}", e);
        }
    });
    Reply::json(json!({"success": true}))
}

/// Per-user fixed one-minute window, 60 requests (process memory, as in TS).
static UPLOAD_RATE: LazyLock<DashMap<String, (u32, i64)>> = LazyLock::new(DashMap::new);

fn check_upload_rate(uid: &str) -> bool {
    let now = now_ms();
    let mut e = UPLOAD_RATE.entry(uid.to_string()).or_insert((0, now));
    if e.0 == 0 || now - e.1 >= 60_000 {
        *e = (1, now);
        return true;
    }
    if e.0 >= 60 {
        return false;
    }
    e.0 += 1;
    true
}

async fn request_upload(app: Arc<App>, req: Req) -> HResult {
    let uid = req.user_id.clone();
    if !check_upload_rate(&uid) {
        return Reply::error(429, "Too many upload requests. Try again in a minute.");
    }
    let Some(project) = find(&app, &req.param("projectId"), &uid).await? else { return not_found() };
    let file = format!("{}.enc", uuid_v4());
    let r = format!("projects/{}/avatar/{}", project.id, file);
    match &app.files.s3 {
        None => Reply::json(json!({
            "ref": r,
            "uploadUrl": format!("{}/v1/projects/{}/avatar/{}", base_url(&app, &req), project.id, file),
            "method": "PUT",
        })),
        Some(s3) => {
            let expires = now_ms() + PRESIGNED_TTL_SECONDS as i64 * 1000;
            let (url, fields) = s3.presigned_post(&app.files.bucket, &r, expires, 0, MAX_FILE_SIZE as u64);
            Reply::json(json!({ "ref": r, "uploadUrl": url, "method": "POST", "formFields": fields }))
        }
    }
}

async fn upload(app: Arc<App>, req: Req) -> HResult {
    if !app.files.is_local() {
        return Reply::error(404, "Direct upload not available in S3 mode");
    }
    let (id, file) = (req.param("projectId"), req.param("avatarFile"));
    if find(&app, &id, &req.user_id).await?.is_none() {
        return not_found();
    }
    let r = format!("projects/{}/avatar/{}", id, file);
    if !valid_ref(&id, &r) {
        return Reply::error(404, "Invalid project avatar file");
    }
    let Some(bytes) = buffer_body(&req).filter(|b| b.len() <= MAX_FILE_SIZE) else {
        return Reply::error(413, "File too large (max 10MB)");
    };
    app.files.put_local(&r, bytes).await?;
    Reply::json(json!({"ok": true}))
}

async fn request_download(app: Arc<App>, req: Req) -> HResult {
    let Some(project) = find(&app, &req.param("projectId"), &req.user_id).await? else { return not_found() };
    let r = match &project.avatar_ref {
        Some(r) if !r.is_empty() && valid_ref(&project.id, r) => r.clone(),
        _ => return Reply::error(404, "Project avatar not found"),
    };
    match &app.files.s3 {
        None => {
            let file = &r[r.rfind('/').map(|i| i + 1).unwrap_or(0)..];
            Reply::json(json!({ "ref": r, "downloadUrl": format!("{}/v1/projects/{}/avatar/{}", base_url(&app, &req), project.id, file) }))
        }
        Some(s3) => Reply::json(json!({ "ref": r, "downloadUrl": s3.presigned_get(&app.files.bucket, &r, PRESIGNED_TTL_SECONDS) })),
    }
}

async fn download(app: Arc<App>, req: Req) -> HResult {
    if !app.files.is_local() {
        return Reply::error(404, "Direct download not available in S3 mode");
    }
    let (id, file) = (req.param("projectId"), req.param("avatarFile"));
    let Some(project) = find(&app, &id, &req.user_id).await? else { return not_found() };
    let r = format!("projects/{}/avatar/{}", id, file);
    if !valid_ref(&id, &r) {
        return Reply::error(404, "Invalid project avatar file");
    }
    if project.avatar_ref.as_deref() != Some(r.as_str()) {
        return Reply::error(404, "Project avatar not found");
    }
    let Some(full) = local_avatar_path(&app, &id, &r) else {
        return Reply::error(404, "Invalid project avatar file");
    };
    if tokio::fs::metadata(&full).await.is_err() {
        return Reply::error(404, "Project avatar not found");
    }
    // `fs.readFileSync` throws on a directory: an uncaught 500.
    Reply::bytes(tokio::fs::read(&full).await?)
}

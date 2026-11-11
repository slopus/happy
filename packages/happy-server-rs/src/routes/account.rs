//! `accountRoutes.ts`.

use crate::app::App;
use crate::events::{update_account_update, Filter};
use crate::h;
use crate::http::{HResult, Reply, Req, Router};
use crate::js;
use crate::zod::{enumeration, literal, number, object, string, union};
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::sync::Arc;

pub fn register(r: &mut Router) {
    r.get("/v1/account/profile").auth().handle(h!(profile));

    r.get("/v1/account/settings")
        .auth()
        .response(200, object(vec![("settings", string().nullable()), ("settingsVersion", number())]))
        .response(500, object(vec![("error", literal(json!("Failed to get account settings")))]))
        .handle(h!(get_settings));

    r.post("/v1/account/settings")
        .body(object(vec![("settings", string().nullable()), ("expectedVersion", number().int().min(0.0))]))
        .response(
            200,
            union(vec![
                object(vec![("success", literal(json!(true))), ("version", number())]),
                object(vec![
                    ("success", literal(json!(false))),
                    ("error", literal(json!("version-mismatch"))),
                    ("currentVersion", number()),
                    ("currentSettings", string().nullable()),
                ]),
            ]),
        )
        .response(500, object(vec![("success", literal(json!(false))), ("error", literal(json!("Failed to update account settings")))]))
        .auth()
        .handle(h!(post_settings));

    r.post("/v1/usage/query")
        .body(object(vec![
            ("sessionId", string().nullish()),
            ("startTime", number().int().positive().nullish()),
            ("endTime", number().int().positive().nullish()),
            ("groupBy", enumeration(&["hour", "day"]).nullish()),
        ]))
        .auth()
        .handle(h!(usage_query));
}

fn parse_json_col(s: Option<String>) -> Value {
    s.and_then(|s| js::parse(&s).ok()).unwrap_or(Value::Null)
}

async fn profile(app: Arc<App>, req: Req) -> HResult {
    let uid = &req.user_id;
    let row = sqlx::query(
        r#"SELECT a."firstName", a."lastName", a."username", a."avatar"::text AS "avatar", g."id" AS "gid", g."profile"::text AS "gprofile"
           FROM "Account" a LEFT JOIN "GithubUser" g ON g."id" = a."githubUserId"
           WHERE a."id" = $1 LIMIT 1"#,
    )
    .bind(uid)
    .fetch_optional(&app.pool)
    .await?
    .ok_or(crate::db::RecordNotFound)?;
    let vendors: Vec<(String,)> =
        sqlx::query_as(r#"SELECT "vendor" FROM "ServiceAccountToken" WHERE "accountId" = $1"#).bind(uid).fetch_all(&app.pool).await?;
    let mut connected: Vec<String> = Vec::new();
    for (v,) in vendors {
        if !connected.contains(&v) {
            connected.push(v);
        }
    }
    let avatar = account_avatar(&app, parse_json_col(row.get("avatar")));
    let gid: Option<String> = row.get("gid");
    let github = if gid.is_some() { parse_json_col(row.get("gprofile")) } else { Value::Null };
    Reply::json(json!({
        "id": uid,
        "timestamp": crate::util::now_ms(),
        "firstName": row.get::<Option<String>, _>("firstName"),
        "lastName": row.get::<Option<String>, _>("lastName"),
        "username": row.get::<Option<String>, _>("username"),
        "avatar": avatar,
        "github": github,
        "connectedServices": connected,
    }))
}

/// `user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null`.
pub fn account_avatar(app: &App, avatar: Value) -> Value {
    if !js::truthy(Some(&avatar)) {
        return Value::Null;
    }
    let path = js::get(Some(&avatar), "path").map(js::to_js_string).unwrap_or_else(|| "undefined".into());
    let mut m = match avatar {
        Value::Object(m) => m,
        // Spreading a primitive copies nothing (strings copy their characters).
        Value::String(s) => s.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        _ => Map::new(),
    };
    m.insert("url".into(), Value::String(app.files.public_url(&path)));
    Value::Object(m)
}

async fn get_settings(app: Arc<App>, req: Req) -> HResult {
    let r: Result<Option<(Option<String>, i32)>, _> = sqlx::query_as(r#"SELECT "settings", "settingsVersion" FROM "Account" WHERE "id" = $1 LIMIT 1"#)
        .bind(&req.user_id)
        .fetch_optional(&app.pool)
        .await;
    match r {
        Ok(Some((settings, version))) => Reply::json(json!({"settings": settings, "settingsVersion": version})),
        _ => Reply::code(500, json!({"error": "Failed to get account settings"})),
    }
}

async fn post_settings(app: Arc<App>, req: Req) -> HResult {
    match post_settings_inner(&app, &req).await {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!(module = "api", "Failed to update account settings: {}", e);
            Reply::code(500, json!({"success": false, "error": "Failed to update account settings"}))
        }
    }
}

async fn post_settings_inner(app: &Arc<App>, req: &Req) -> anyhow::Result<Reply> {
    let uid = &req.user_id;
    let settings = req.body_field("settings").and_then(|v| v.as_str()).map(|s| s.to_string());
    let expected = req.body_field("expectedVersion").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
    let current: Option<(Option<String>, i32)> = sqlx::query_as(r#"SELECT "settings", "settingsVersion" FROM "Account" WHERE "id" = $1 LIMIT 1"#)
        .bind(uid)
        .fetch_optional(&app.pool)
        .await?;
    let Some((cur_settings, cur_version)) = current else {
        return Ok(Reply { status: 500, headers: vec![], body: crate::http::Body::Json(json!({"success": false, "error": "Failed to update account settings"})) });
    };
    if cur_version as i64 != expected {
        return Reply::json(json!({"success": false, "error": "version-mismatch", "currentVersion": cur_version, "currentSettings": cur_settings}));
    }
    let n = sqlx::query(r#"UPDATE "Account" SET "settings" = $1, "settingsVersion" = $2, "updatedAt" = $3 WHERE "id" = $4 AND "settingsVersion" = $5"#)
        .bind(&settings)
        .bind((expected + 1) as i32)
        .bind(crate::db::now())
        .bind(uid)
        .bind(expected as i32)
        .execute(&app.pool)
        .await?
        .rows_affected();
    if n == 0 {
        let acc: Option<(Option<String>, i32)> = sqlx::query_as(r#"SELECT "settings", "settingsVersion" FROM "Account" WHERE "id" = $1 LIMIT 1"#)
            .bind(uid)
            .fetch_optional(&app.pool)
            .await?;
        // `account?.settingsVersion || 0`, `account?.settings || null`.
        let (s, v) = acc.unwrap_or((None, 0));
        return Reply::json(json!({
            "success": false,
            "error": "version-mismatch",
            "currentVersion": v,
            "currentSettings": s.filter(|s| !s.is_empty()),
        }));
    }
    let seq = crate::db::allocate_user_seq_pool(&app.pool, uid).await?;
    let payload = update_account_update(uid, vec![("settings", json!({"value": settings, "version": expected + 1}))], None, seq);
    app.hub.emit_update(uid, payload, Filter::UserScopedOnly, None);
    Reply::json(json!({"success": true, "version": expected + 1}))
}

async fn usage_query(app: Arc<App>, req: Req) -> HResult {
    match usage_inner(&app, &req).await {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!(module = "api", "Failed to query usage reports: {}", e);
            Reply::code(500, json!({"error": "Failed to query usage reports"}))
        }
    }
}

/// `new Date(y, m, d, h)` in the server's local time zone, in epoch seconds.
fn local_bucket(ms: i64, hour: bool) -> anyhow::Result<i64> {
    let t = Local.timestamp_millis_opt(ms).single().ok_or_else(|| anyhow::anyhow!("Invalid Date"))?;
    let h = if hour { t.hour() } else { 0 };
    let naive = chrono::NaiveDate::from_ymd_opt(t.year(), t.month(), t.day()).and_then(|d| d.and_hms_opt(h, 0, 0)).ok_or_else(|| anyhow::anyhow!("Invalid Date"))?;
    let local = match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(x) => x,
        chrono::LocalResult::Ambiguous(a, _) => a,
        // Inside a DST gap JS moves forward by the gap.
        chrono::LocalResult::None => Local
            .from_local_datetime(&(naive + chrono::Duration::hours(1)))
            .earliest()
            .ok_or_else(|| anyhow::anyhow!("Invalid Date"))?,
    };
    Ok(local.timestamp_millis().div_euclid(1000))
}

/// `Object.entries(x)` for a JSON value; `null`/`undefined` throw.
fn entries(v: Option<&Value>) -> anyhow::Result<Vec<(String, Value)>> {
    match v {
        None | Some(Value::Null) => anyhow::bail!("Cannot convert undefined or null to object"),
        Some(Value::Object(m)) => Ok(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        Some(Value::Array(a)) => Ok(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
        Some(Value::String(s)) => Ok(s.encode_utf16().enumerate().map(|(i, c)| (i.to_string(), Value::String(String::from_utf16_lossy(&[c])))).collect()),
        Some(_) => Ok(vec![]),
    }
}

struct Agg {
    tokens: Map<String, Value>,
    cost: Map<String, Value>,
    count: i64,
    timestamp: i64,
}

fn add_into(m: &mut Map<String, Value>, k: String, v: f64) {
    let cur = m.get(&k).and_then(js::as_f64).unwrap_or(0.0);
    m.insert(k, js::num(cur + v));
}

async fn usage_inner(app: &Arc<App>, req: &Req) -> anyhow::Result<Reply> {
    let uid = &req.user_id;
    let session_id = req.body_field("sessionId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let start = req.body_field("startTime").and_then(|v| v.as_f64()).filter(|v| *v != 0.0);
    let end = req.body_field("endTime").and_then(|v| v.as_f64()).filter(|v| *v != 0.0);
    let group_by = req.body_field("groupBy").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("day").to_string();

    if let Some(sid) = &session_id {
        let found: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
            .bind(sid)
            .bind(uid)
            .fetch_optional(&app.pool)
            .await?;
        if found.is_none() {
            return Reply::code(404, json!({"error": "Session not found"}));
        }
    }
    let gte = start.map(|s| super::js_date_ms(s * 1000.0)).transpose()?;
    let lte = end.map(|s| super::js_date_ms(s * 1000.0)).transpose()?;
    let mut q = String::from(r#"SELECT "data"::text AS "data", "createdAt" FROM "UsageReport" WHERE "accountId" = $1"#);
    let mut n = 1;
    if session_id.is_some() {
        n += 1;
        q.push_str(&format!(r#" AND "sessionId" = ${}"#, n));
    }
    if gte.is_some() {
        n += 1;
        q.push_str(&format!(r#" AND "createdAt" >= ${}"#, n));
    }
    if lte.is_some() {
        n += 1;
        q.push_str(&format!(r#" AND "createdAt" <= ${}"#, n));
    }
    q.push_str(r#" ORDER BY "createdAt" DESC"#);
    let mut query = sqlx::query(&q).bind(uid);
    if let Some(s) = &session_id {
        query = query.bind(s);
    }
    if let Some(t) = gte {
        query = query.bind(t);
    }
    if let Some(t) = lte {
        query = query.bind(t);
    }
    let rows = query.fetch_all(&app.pool).await?;

    let mut order: Vec<String> = Vec::new();
    let mut aggs: std::collections::HashMap<String, Agg> = std::collections::HashMap::new();
    for r in &rows {
        let data = parse_json_col(r.get("data"));
        let created: chrono::NaiveDateTime = r.get("createdAt");
        let ts = local_bucket(crate::util::naive_to_ms(created), group_by == "hour")?;
        let key = ts.to_string();
        if !aggs.contains_key(&key) {
            order.push(key.clone());
            aggs.insert(key.clone(), Agg { tokens: Map::new(), cost: Map::new(), count: 0, timestamp: ts });
        }
        let agg = aggs.get_mut(&key).unwrap();
        agg.count += 1;
        let data_ref = if data.is_null() { None } else { Some(&data) };
        if data_ref.is_none() {
            anyhow::bail!("Cannot read properties of null (reading 'tokens')");
        }
        for (k, v) in entries(js::get(data_ref, "tokens"))? {
            if let Some(n) = js::as_f64(&v) {
                add_into(&mut agg.tokens, k, n);
            }
        }
        for (k, v) in entries(js::get(data_ref, "cost"))? {
            if let Some(n) = js::as_f64(&v) {
                add_into(&mut agg.cost, k, n);
            }
        }
    }
    let mut result: Vec<Agg> = order.into_iter().filter_map(|k| aggs.remove(&k)).collect();
    result.sort_by_key(|a| a.timestamp);
    let usage: Vec<Value> = result
        .into_iter()
        .map(|mut a| {
            js::js_order(&mut a.tokens);
            js::js_order(&mut a.cost);
            json!({"timestamp": a.timestamp, "tokens": a.tokens, "cost": a.cost, "reportCount": a.count})
        })
        .collect();
    Reply::json(json!({"usage": usage, "groupBy": group_by, "totalReports": rows.len()}))
}

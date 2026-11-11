//! Socket event handlers (`sources/app/api/socket/*Handler.ts`).
//!
//! Handlers see their arguments the way the JS listeners do: `data` is the first
//! packet argument, `callback` the second (the ack function only when the client
//! sent nothing else), destructuring `null`/`undefined` throws, and calling a
//! callback that is not the ack function throws. A throw inside a `catch` block
//! is an unhandled rejection that ends the TS process; here it is logged and the
//! event is dropped (QUIRKS.md, known deviations).

use crate::app::App;
use crate::db;
use crate::engine::Cmd;
use crate::events::{self, ConnType, Filter, SocketHandle};
use crate::js;
use crate::models::{Artifact, Machine, ARTIFACT_COLS, MACHINE_COLS};
use crate::routes::sessions::{find_session, message_from_row, MESSAGE_COLS};
use crate::socket;
use crate::util::{cuid, ms_to_naive, naive_to_ms, now_ms, stablelib_b64_decode};
use anyhow::{anyhow, bail};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

pub enum Arg {
    Val(Value),
    Ack(Ack),
}

/// The function socket.io appends for a packet with an ack id; answers once.
#[derive(Clone)]
pub struct Ack {
    tx: mpsc::UnboundedSender<Cmd>,
    id: f64,
    sent: Arc<AtomicBool>,
}

impl Ack {
    pub fn new(tx: mpsc::UnboundedSender<Cmd>, id: f64) -> Ack {
        Ack { tx, id, sent: Arc::new(AtomicBool::new(false)) }
    }

    pub fn send(&self, args: Vec<Value>) {
        if self.sent.swap(true, Ordering::Relaxed) {
            return;
        }
        let (t, a) = socket::encode(socket::ACK, "/", Some(self.id), Some(&Value::Array(args)));
        let _ = self.tx.send(Cmd::Emit(t, a));
    }
}

pub struct Args(pub Vec<Arg>);

/// One listener parameter as JS sees it.
pub enum J<'a> {
    Undef,
    Val(&'a Value),
    Func(&'a Ack),
}

impl Args {
    pub fn j(&self, i: usize) -> J<'_> {
        match self.0.get(i) {
            None => J::Undef,
            Some(Arg::Val(v)) => J::Val(v),
            Some(Arg::Ack(a)) => J::Func(a),
        }
    }
}

impl<'a> J<'a> {
    pub fn nullish(&self) -> bool {
        matches!(self, J::Undef | J::Val(Value::Null))
    }

    pub fn truthy(&self) -> bool {
        match self {
            J::Undef => false,
            J::Val(v) => js::truthy(Some(v)),
            J::Func(_) => true,
        }
    }

    /// `data.key` (a function has none of the keys handlers read).
    pub fn get(&self, k: &str) -> Option<&'a Value> {
        match self {
            J::Val(v) => js::get(Some(v), k),
            _ => None,
        }
    }

    /// `const { ... } = data`.
    pub fn destructure(&self) -> anyhow::Result<()> {
        if self.nullish() {
            bail!("TypeError: Cannot destructure property of undefined");
        }
        Ok(())
    }

    /// `callback(v)`.
    pub fn call(&self, v: Value) -> anyhow::Result<()> {
        match self {
            J::Func(a) => {
                a.send(vec![v]);
                Ok(())
            }
            _ => bail!("TypeError: callback is not a function"),
        }
    }

    /// `callback?.(v)`.
    pub fn call_opt(&self, v: Value) -> anyhow::Result<()> {
        if self.nullish() {
            Ok(())
        } else {
            self.call(v)
        }
    }

    /// `if (callback) callback(v)`.
    pub fn call_if(&self, v: Value) -> anyhow::Result<()> {
        if self.truthy() {
            self.call(v)
        } else {
            Ok(())
        }
    }
}

/// A Prisma `where` value that must be a string (anything else is a validation error).
fn pstr(v: Option<&Value>) -> anyhow::Result<&str> {
    match v {
        Some(Value::String(s)) => Ok(s),
        _ => bail!("PrismaClientValidationError: expected String"),
    }
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(js::as_f64).unwrap_or(f64::NAN)
}

fn is_num(v: Option<&Value>) -> bool {
    js::is_number(v)
}

pub fn crashed(event: &str, e: &anyhow::Error) {
    tracing::error!(module = "websocket", "Error in {} handler's catch block (the TS server exits here): {}", event, e);
}

fn count_event(app: &App, s: &SocketHandle, event: &str) {
    app.metrics.websocket_events.with_label_values(&[event, &s.labels.0, &s.labels.1]).inc();
}

pub fn dispatch(app: &Arc<App>, s: &Arc<SocketHandle>, name: &str, args: Vec<Arg>) {
    let args = Args(args);
    let (a, sh) = (app.clone(), s.clone());
    match name {
        "app-state" => {
            let d = args.j(0);
            let active = d.get("state") == Some(&Value::String("active".into()));
            *s.app_state.lock() = Some(if active { "active" } else { "background" });
        }
        "ping" => {
            if let Err(e) = args.j(0).call(json!({})) {
                tracing::error!(module = "websocket", "Error in ping: {}", e);
            }
        }
        "rpc-register" => crate::rpc::register(app, s, &args, true),
        "rpc-unregister" => crate::rpc::register(app, s, &args, false),
        "rpc-call" => {
            tokio::spawn(crate::rpc::call(a, sh, args));
        }
        "update-metadata" => {
            tokio::spawn(update_session_field(a, sh, args, false));
        }
        "update-state" => {
            tokio::spawn(update_session_field(a, sh, args, true));
        }
        "session-alive" => {
            tokio::spawn(session_alive(a, sh, args));
        }
        "session-end" => {
            tokio::spawn(session_end(a, sh, args));
        }
        "message" => s.enqueue("message", Box::pin(message(a, sh, args))),
        "usage-report" => s.enqueue("usage", Box::pin(usage_report(a, sh, args))),
        "session-subscribe" => s.enqueue("subscribe", Box::pin(session_subscribe(a, sh, args, true))),
        "session-unsubscribe" => s.enqueue("subscribe", Box::pin(session_subscribe(a, sh, args, false))),
        "machine-alive" => {
            tokio::spawn(machine_alive(a, sh, args));
        }
        "machine-update-metadata" => {
            tokio::spawn(machine_update(a, sh, args, false));
        }
        "machine-update-state" => {
            tokio::spawn(machine_update(a, sh, args, true));
        }
        "artifact-read" => {
            tokio::spawn(artifact_read(a, sh, args));
        }
        "artifact-update" => {
            tokio::spawn(artifact_update(a, sh, args));
        }
        "artifact-create" => {
            tokio::spawn(artifact_create(a, sh, args));
        }
        "artifact-delete" => {
            tokio::spawn(artifact_delete(a, sh, args));
        }
        "access-key-get" => {
            tokio::spawn(access_key_get(a, sh, args));
        }
        "error" => {
            // EventEmitter throws on an unhandled 'error' event: the TS process exits.
            tracing::error!(module = "websocket", "client sent an 'error' event (crashes the TS server); ignored");
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// sessionUpdateHandler.ts
// ---------------------------------------------------------------------------

/// `update-metadata` (agent_state = false) and `update-state`.
async fn update_session_field(app: Arc<App>, s: Arc<SocketHandle>, args: Args, agent_state: bool) {
    let cb = args.j(1);
    let event = if agent_state { "update-state" } else { "update-metadata" };
    let (field, col, ver_col) = if agent_state { ("agentState", "agentState", "agentStateVersion") } else { ("metadata", "metadata", "metadataVersion") };
    let r: anyhow::Result<()> = async {
        let d = args.j(0);
        d.destructure()?;
        let sid = d.get("sid");
        let value = d.get(field);
        let ev = d.get("expectedVersion");
        let value_ok = matches!(value, Some(Value::String(_))) || (agent_state && value == Some(&Value::Null));
        if !js::truthy(sid) || !value_ok || !is_num(ev) {
            return cb.call_if(json!({"result": "error"}));
        }
        let sid = pstr(sid)?;
        let Some(session) = find_session(&app, sid, &s.user_id).await? else {
            return if agent_state { cb.call(json!({"result": "error"})) } else { Ok(()) };
        };
        let (cur_ver, cur_val) = if agent_state {
            (session.agent_state_version, json!(session.agent_state))
        } else {
            (session.metadata_version, json!(session.metadata))
        };
        let mismatch = || {
            let mut m = Map::new();
            m.insert("result".into(), json!("version-mismatch"));
            m.insert("version".into(), json!(cur_ver));
            m.insert(field.into(), cur_val.clone());
            Value::Object(m)
        };
        let ev = num(ev);
        if cur_ver as f64 != ev {
            return cb.call(mismatch());
        }
        let next = cur_ver.checked_add(1).ok_or_else(|| anyhow!("integer overflow"))?;
        let n = sqlx::query(&format!(
            r#"UPDATE "Session" SET "{}" = $1, "{}" = $2, "updatedAt" = $3 WHERE "id" = $4 AND "{}" = $5"#,
            col, ver_col, ver_col
        ))
        .bind(value.and_then(|v| v.as_str()))
        .bind(next)
        .bind(db::now())
        .bind(sid)
        .bind(cur_ver)
        .execute(&app.pool)
        .await?
        .rows_affected();
        if n == 0 {
            return cb.call(mismatch());
        }
        let seq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        let upd = json!({"value": value, "version": next});
        let payload = events::update_session_update(
            sid,
            seq,
            events::SessionUpdate {
                metadata: if agent_state { None } else { Some(upd.clone()) },
                agent_state: if agent_state { Some(upd) } else { None },
                project_id: None,
                avatar: None,
                avatar_version: None,
            },
        );
        app.hub.emit_update(&s.user_id, payload, Filter::Session(sid), None);
        let mut ok = Map::new();
        ok.insert("result".into(), json!("success"));
        ok.insert("version".into(), json!(next));
        ok.insert(field.into(), value.cloned().unwrap_or(Value::Null));
        cb.call(Value::Object(ok))
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in {}: {}", event, e);
        if let Err(e) = cb.call_if(json!({"result": "error"})) {
            crashed(event, &e);
        }
    }
}

/// Heartbeat time handling shared by `session-alive` and `machine-alive`:
/// clamped to now, ignored when older than 10 minutes.
fn heartbeat_time(t: f64) -> Option<f64> {
    let now = now_ms() as f64;
    let t = if t > now { now } else { t };
    if t < now_ms() as f64 - 10.0 * 60.0 * 1000.0 {
        return None;
    }
    Some(t)
}

async fn session_alive(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    count_event(&app, &s, "session-alive");
    app.metrics.session_alive_events.inc();
    let d = args.j(0);
    if !d.truthy() || !is_num(d.get("time")) || !js::truthy(d.get("sid")) {
        return;
    }
    let Some(t) = heartbeat_time(num(d.get("time"))) else { return };
    let Some(Value::String(sid)) = d.get("sid") else {
        // A non-string id misses the cache and fails the lookup.
        app.metrics.session_cache.with_label_values(&["session_validation", "miss"]).inc();
        return;
    };
    if !app.activity.is_session_valid(sid, &s.user_id).await {
        return;
    }
    app.activity.queue_session_update(sid, t as i64);
    let thinking = match d.get("thinking") {
        v if js::truthy(v) => v.cloned().unwrap(),
        _ => Value::Bool(false),
    };
    let e = json!({"type": "activity", "id": sid, "active": true, "activeAt": js::num(t), "thinking": thinking});
    app.hub.emit_ephemeral(&s.user_id, e, Filter::UserScopedOnly);
}

async fn session_end(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let r: anyhow::Result<()> = async {
        let d = args.j(0);
        d.destructure()?;
        let time = d.get("time");
        if !is_num(time) {
            return Ok(());
        }
        let Some(t) = heartbeat_time(num(time)) else { return Ok(()) };
        let sid = pstr(d.get("sid"))?;
        if find_session(&app, sid, &s.user_id).await?.is_none() {
            return Ok(());
        }
        app.activity.clear_session_updates(sid);
        let r = sqlx::query(r#"UPDATE "Session" SET "lastActiveAt" = $1, "active" = false, "updatedAt" = $2 WHERE "id" = $3"#)
            .bind(ms_to_naive(t as i64))
            .bind(db::now())
            .bind(sid)
            .execute(&app.pool)
            .await?;
        db::expect_row(r)?;
        app.hub.emit_ephemeral(&s.user_id, events::session_activity(sid, false, t, false), Filter::UserScopedOnly);
        Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in session-end: {}", e);
    }
}

async fn message(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, "message");
        let d = args.j(0);
        d.destructure()?;
        let (sid, message, local_id) = (d.get("sid"), d.get("message"), d.get("localId"));
        let Some(message) = message.filter(|m| !m.is_null()) else {
            bail!("TypeError: Cannot read properties of undefined (reading 'length')");
        };
        let len = match message {
            Value::String(x) => js::format_number(x.encode_utf16().count() as f64),
            Value::Array(a) => a.len().to_string(),
            _ => "undefined".into(),
        };
        tracing::info!(
            module = "websocket",
            "Received message from socket {}: sessionId={}, messageLength={} bytes, connectionType={}, connectionSessionId={}",
            s.id,
            sid.map(js::to_js_string).unwrap_or_else(|| "undefined".into()),
            len,
            s.conn_type.as_str(),
            if s.conn_type == ConnType::SessionScoped { s.session_id.as_deref().unwrap_or("") } else { "N/A" }
        );
        let sid = pstr(sid)?;
        if find_session(&app, sid, &s.user_id).await?.is_none() {
            return Ok(());
        }
        let local_id = local_id.and_then(|v| v.as_str());
        let content = js::stringify(&json!({"t": "encrypted", "c": socket::buffers_to_json(message)}));
        let upd_seq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        let msg_seq = {
            let mut c = app.pool.acquire().await?;
            db::allocate_session_seq_batch(&mut c, sid, 1).await?[0]
        };
        if let Some(l) = local_id {
            let existing: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "SessionMessage" WHERE "sessionId" = $1 AND "localId" = $2 LIMIT 1"#)
                .bind(sid)
                .bind(l)
                .fetch_optional(&app.pool)
                .await?;
            if existing.is_some() {
                return Ok(());
            }
        }
        let now = db::now();
        let row = sqlx::query(&format!(
            r#"INSERT INTO "SessionMessage" ("id","sessionId","seq","content","localId","createdAt","updatedAt")
               VALUES ($1,$2,$3,$4::jsonb,$5,$6,$6) RETURNING {}"#,
            MESSAGE_COLS
        ))
        .bind(cuid())
        .bind(sid)
        .bind(msg_seq)
        .bind(&content)
        .bind(local_id)
        .bind(now)
        .fetch_one(&app.pool)
        .await?;
        let msg = message_from_row(&row);
        app.hub.emit_update(&s.user_id, events::new_message_update(&msg.json(), sid, upd_seq), Filter::Session(sid), Some(&s.id));
        Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in message handler: {}", e);
    }
}

// ---------------------------------------------------------------------------
// sessionSubscribeHandler.ts
// ---------------------------------------------------------------------------

/// `z.object({ sids: z.array(z.string()).min(1).max(500) })`.
fn parse_sids(d: &J) -> Option<Vec<String>> {
    let J::Val(Value::Object(m)) = d else { return None };
    let Some(Value::Array(a)) = m.get("sids") else { return None };
    if a.is_empty() || a.len() > 500 {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for v in a {
        let Value::String(x) = v else { return None };
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    Some(out)
}

async fn session_subscribe(app: Arc<App>, s: Arc<SocketHandle>, args: Args, subscribe: bool) {
    let cb = args.j(1);
    let event = if subscribe { "session-subscribe" } else { "session-unsubscribe" };
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, event);
        if s.conn_type != ConnType::MachineScoped {
            return cb.call_opt(json!({"result": "error", "reason": "unsupported-client"}));
        }
        let Some(sids) = parse_sids(&args.j(0)) else {
            return cb.call_opt(json!({"result": "error", "reason": "invalid"}));
        };
        if !subscribe {
            for sid in &sids {
                app.hub.leave(&s, &format!("user:{}:session:{}", s.user_id, sid));
            }
            return cb.call_opt(json!({"result": "success"}));
        }
        let owned: Vec<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "accountId" = $1 AND "id" = ANY($2)"#)
            .bind(&s.user_id)
            .bind(&sids)
            .fetch_all(&app.pool)
            .await?;
        let owned: std::collections::HashSet<String> = owned.into_iter().map(|r| r.0).collect();
        let (subscribed, missing): (Vec<String>, Vec<String>) = sids.into_iter().partition(|x| owned.contains(x));
        for sid in &subscribed {
            app.hub.join(&s, &format!("user:{}:session:{}", s.user_id, sid));
        }
        tracing::info!(
            module = "websocket",
            "session-subscribe: machine {}, subscribed {}, missing {}",
            s.machine_id.as_deref().unwrap_or("undefined"),
            subscribed.len(),
            missing.len()
        );
        cb.call_opt(json!({"result": "success", "subscribed": subscribed, "missing": missing}))
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in {}: {}", event, e);
        if let Err(e) = cb.call_opt(json!({"result": "error", "reason": "internal"})) {
            crashed(event, &e);
        }
    }
}

// ---------------------------------------------------------------------------
// usageHandler.ts
// ---------------------------------------------------------------------------

async fn usage_report(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        let d = args.j(0);
        d.destructure()?;
        let (key, session_id, tokens, cost) = (d.get("key"), d.get("sessionId"), d.get("tokens"), d.get("cost"));
        let Some(Value::String(key)) = key.filter(|k| js::truthy(Some(k))) else {
            return cb.call_if(json!({"success": false, "error": "Invalid key"}));
        };
        let valid_total = |v: Option<&Value>| js::truthy(v) && js::is_object_type(v) && is_num(js::get(v, "total"));
        if !valid_total(tokens) {
            return cb.call_if(json!({"success": false, "error": "Invalid tokens object - must include total"}));
        }
        if !valid_total(cost) {
            return cb.call_if(json!({"success": false, "error": "Invalid cost object - must include total"}));
        }
        if js::truthy(session_id) && !js::is_string(session_id) {
            return cb.call_if(json!({"success": false, "error": "Invalid sessionId"}));
        }
        let (tokens, cost) = (tokens.unwrap(), cost.unwrap());
        let saved: anyhow::Result<()> = async {
            let sid = session_id.and_then(|v| v.as_str()).filter(|v| !v.is_empty());
            let Some(sid) = sid else {
                // `sessionId: null` in the compound unique `where` fails Prisma validation.
                bail!("PrismaClientValidationError: Argument `sessionId` must not be null");
            };
            if find_session(&app, sid, &s.user_id).await?.is_none() {
                return cb.call_if(json!({"success": false, "error": "Session not found"}));
            }
            let data = js::stringify(&socket::buffers_to_json(&json!({"tokens": tokens, "cost": cost})));
            let now = db::now();
            let (id, created, updated): (String, chrono::NaiveDateTime, chrono::NaiveDateTime) = sqlx::query_as(
                r#"INSERT INTO "UsageReport" ("id","key","accountId","sessionId","data","createdAt","updatedAt")
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
                   ON CONFLICT ("accountId","sessionId","key") DO UPDATE SET "data" = EXCLUDED."data", "updatedAt" = $6
                   RETURNING "id","createdAt","updatedAt""#,
            )
            .bind(cuid())
            .bind(key)
            .bind(&s.user_id)
            .bind(sid)
            .bind(&data)
            .bind(now)
            .fetch_one(&app.pool)
            .await?;
            tracing::info!(module = "websocket", "Usage report saved: key={}, sessionId={}, userId={}", key, sid, s.user_id);
            app.hub.emit_ephemeral(&s.user_id, events::usage_ephemeral(sid, key, tokens, cost), Filter::UserScopedOnly);
            cb.call_if(json!({"success": true, "reportId": id, "createdAt": naive_to_ms(created), "updatedAt": naive_to_ms(updated)}))
        }
        .await;
        if let Err(e) = saved {
            tracing::error!(module = "websocket", "Failed to save usage report: {}", e);
            cb.call_if(json!({"success": false, "error": "Failed to save usage report"}))?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in usage-report handler: {}", e);
        if let Err(e) = cb.call_if(json!({"success": false, "error": "Internal error"})) {
            crashed("usage-report", &e);
        }
    }
}

// ---------------------------------------------------------------------------
// machineUpdateHandler.ts
// ---------------------------------------------------------------------------

async fn machine_alive(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    count_event(&app, &s, "machine-alive");
    app.metrics.machine_alive_events.inc();
    let d = args.j(0);
    if !d.truthy() || !is_num(d.get("time")) || !js::truthy(d.get("machineId")) {
        return;
    }
    let Some(t) = heartbeat_time(num(d.get("time"))) else { return };
    let Some(Value::String(mid)) = d.get("machineId") else {
        app.metrics.session_cache.with_label_values(&["machine_validation", "miss"]).inc();
        return;
    };
    if !app.activity.is_machine_valid(mid, &s.user_id).await {
        return;
    }
    app.activity.queue_machine_update(mid, t as i64);
    app.hub.emit_ephemeral(&s.user_id, events::machine_activity(&json!(mid), true, t), Filter::UserScopedOnly);
}

async fn find_machine(app: &App, uid: &str, id: &str) -> anyhow::Result<Option<Machine>> {
    let row = sqlx::query(&format!(r#"SELECT {} FROM "Machine" WHERE "accountId" = $1 AND "id" = $2 LIMIT 1"#, MACHINE_COLS))
        .bind(uid)
        .bind(id)
        .fetch_optional(&app.pool)
        .await?;
    Ok(row.as_ref().map(Machine::from_row))
}

/// `machine-update-metadata` (state = false) and `machine-update-state`.
async fn machine_update(app: Arc<App>, s: Arc<SocketHandle>, args: Args, state: bool) {
    let cb = args.j(1);
    let event = if state { "machine-update-state" } else { "machine-update-metadata" };
    let field = if state { "daemonState" } else { "metadata" };
    let r: anyhow::Result<()> = async {
        let d = args.j(0);
        d.destructure()?;
        let (mid, value, ev) = (d.get("machineId"), d.get(field), d.get("expectedVersion"));
        if !js::truthy(mid) || !js::is_string(value) || !is_num(ev) {
            return cb.call_if(json!({"result": "error", "message": "Invalid parameters"}));
        }
        let mid = pstr(mid)?;
        let value = value.and_then(|v| v.as_str()).unwrap();
        let Some(m) = find_machine(&app, &s.user_id, mid).await? else {
            return cb.call_if(json!({"result": "error", "message": "Machine not found"}));
        };
        let current = |m: &Machine| if state { (m.daemon_state_version, json!(m.daemon_state)) } else { (m.metadata_version, json!(m.metadata)) };
        let (cur_ver, cur_val) = current(&m);
        let mismatch = |ver: i32, val: Option<Value>| {
            let mut o = Map::new();
            o.insert("result".into(), json!("version-mismatch"));
            o.insert("version".into(), json!(ver));
            if let Some(v) = val {
                o.insert(field.into(), v);
            }
            Value::Object(o)
        };
        let ev = num(ev);
        if cur_ver as f64 != ev {
            return cb.call(mismatch(cur_ver, Some(cur_val)));
        }
        let next = cur_ver.checked_add(1).ok_or_else(|| anyhow!("integer overflow"))?;
        let now = db::now();
        let q = if state {
            r#"UPDATE "Machine" SET "daemonState" = $1, "daemonStateVersion" = $2, "active" = true, "lastActiveAt" = $3, "updatedAt" = $3
               WHERE "accountId" = $4 AND "id" = $5 AND "daemonStateVersion" = $6"#
        } else {
            r#"UPDATE "Machine" SET "metadata" = $1, "metadataVersion" = $2, "updatedAt" = $3
               WHERE "accountId" = $4 AND "id" = $5 AND "metadataVersion" = $6"#
        };
        let n = sqlx::query(q).bind(value).bind(next).bind(now).bind(&s.user_id).bind(mid).bind(cur_ver).execute(&app.pool).await?.rows_affected();
        if n == 0 {
            let cur = find_machine(&app, &s.user_id, mid).await?;
            let (ver, val) = match cur.as_ref().map(current) {
                Some((v, x)) => (v, Some(x)),
                None => (0, None),
            };
            return cb.call(mismatch(ver, val));
        }
        let seq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        let upd = json!({"value": value, "version": next});
        let payload = if state { events::update_machine_update(mid, seq, None, Some(upd)) } else { events::update_machine_update(mid, seq, Some(upd), None) };
        app.hub.emit_update(&s.user_id, payload, Filter::Machine(mid), None);
        let mut ok = Map::new();
        ok.insert("result".into(), json!("success"));
        ok.insert("version".into(), json!(next));
        ok.insert(field.into(), json!(value));
        cb.call(Value::Object(ok))
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in {}: {}", event, e);
        if let Err(e) = cb.call_if(json!({"result": "error", "message": "Internal error"})) {
            crashed(event, &e);
        }
    }
}

// ---------------------------------------------------------------------------
// artifactUpdateHandler.ts
// ---------------------------------------------------------------------------

async fn find_artifact(app: &App, id: &str, uid: &str) -> anyhow::Result<Option<Artifact>> {
    let row = sqlx::query(&format!(r#"SELECT {} FROM "Artifact" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#, ARTIFACT_COLS))
        .bind(id)
        .bind(uid)
        .fetch_optional(&app.pool)
        .await?;
    Ok(row.as_ref().map(Artifact::from_row))
}

fn b64(s: &str) -> anyhow::Result<Vec<u8>> {
    stablelib_b64_decode(s).map_err(|e| anyhow!(e))
}

/// Runs an artifact handler body with the shared catch block.
async fn artifact_guard(event: &str, cb: &J<'_>, r: anyhow::Result<()>) {
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in {}: {}", event, e);
        if let Err(e) = cb.call_if(json!({"result": "error", "message": "Internal error"})) {
            crashed(event, &e);
        }
    }
}

async fn artifact_read(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, "artifact-read");
        let d = args.j(0);
        d.destructure()?;
        let id = d.get("artifactId");
        if !js::truthy(id) {
            return cb.call_if(json!({"result": "error", "message": "Invalid parameters"}));
        }
        let Some(a) = find_artifact(&app, pstr(id)?, &s.user_id).await? else {
            return cb.call_if(json!({"result": "error", "message": "Artifact not found"}));
        };
        cb.call(json!({"result": "success", "artifact": a.socket_json()}))
    }
    .await;
    artifact_guard("artifact-read", &cb, r).await;
}

async fn artifact_update(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, "artifact-update");
        let d = args.j(0);
        d.destructure()?;
        let (id, header, body) = (d.get("artifactId"), d.get("header"), d.get("body"));
        if !js::truthy(id) {
            return cb.call_if(json!({"result": "error", "message": "Invalid parameters"}));
        }
        let (has_h, has_b) = (js::truthy(header), js::truthy(body));
        if !has_h && !has_b {
            return cb.call_if(json!({"result": "error", "message": "No updates provided"}));
        }
        let part_ok = |v: Option<&Value>| js::is_string(js::get(v, "data")) && is_num(js::get(v, "expectedVersion"));
        if has_h && !part_ok(header) {
            return cb.call_if(json!({"result": "error", "message": "Invalid header parameters"}));
        }
        if has_b && !part_ok(body) {
            return cb.call_if(json!({"result": "error", "message": "Invalid body parameters"}));
        }
        let id = pstr(id)?;
        let Some(cur) = find_artifact(&app, id, &s.user_id).await? else {
            return cb.call_if(json!({"result": "error", "message": "Artifact not found"}));
        };
        let part = |v: Option<&Value>| (js::get(v, "data").and_then(|x| x.as_str()).unwrap_or("").to_string(), num(js::get(v, "expectedVersion")));
        let (hd, hv) = part(header);
        let (bd, bv) = part(body);
        let mismatch_resp = |a: &Artifact, h: bool, b: bool| {
            let mut o = Map::new();
            o.insert("result".into(), json!("version-mismatch"));
            if h {
                o.insert("header".into(), json!({"currentVersion": a.header_version, "currentData": crate::util::b64_encode(&a.header)}));
            }
            if b {
                o.insert("body".into(), json!({"currentVersion": a.body_version, "currentData": crate::util::b64_encode(&a.body)}));
            }
            Value::Object(o)
        };
        let hm = has_h && cur.header_version as f64 != hv;
        let bm = has_b && cur.body_version as f64 != bv;
        if hm || bm {
            return cb.call(mismatch_resp(&cur, hm, bm));
        }
        let seq = cur.seq.checked_add(1).ok_or_else(|| anyhow!("integer overflow"))?;
        let hbytes = if has_h { Some(b64(&hd)?) } else { None };
        let bbytes = if has_b { Some(b64(&bd)?) } else { None };
        let (hv, bv) = (cur.header_version, cur.body_version);
        let (hn, bn) = (hv.checked_add(1).ok_or_else(|| anyhow!("overflow"))?, bv.checked_add(1).ok_or_else(|| anyhow!("overflow"))?);
        let mut sets = String::from(r#""updatedAt" = $1, "seq" = $2"#);
        let mut wheres = String::from(r#""id" = $3 AND "accountId" = $4"#);
        let mut i = 5;
        for (on, data, ver) in [(has_h, "header", "headerVersion"), (has_b, "body", "bodyVersion")] {
            if on {
                sets.push_str(&format!(r#", "{}" = ${}, "{}" = ${}"#, data, i, ver, i + 1));
                wheres.push_str(&format!(r#" AND "{}" = ${}"#, ver, i + 2));
                i += 3;
            }
        }
        let sql = format!(r#"UPDATE "Artifact" SET {} WHERE {}"#, sets, wheres);
        let mut q = sqlx::query(&sql).bind(db::now()).bind(seq).bind(id).bind(&s.user_id);
        if let Some(h) = &hbytes {
            q = q.bind(h).bind(hn).bind(hv);
        }
        if let Some(b) = &bbytes {
            q = q.bind(b).bind(bn).bind(bv);
        }
        let n = q.execute(&app.pool).await?.rows_affected();
        if n == 0 {
            let current = find_artifact(&app, id, &s.user_id).await?;
            let resp = match &current {
                Some(c) => mismatch_resp(c, has_h, has_b),
                None => json!({"result": "version-mismatch"}),
            };
            return cb.call(resp);
        }
        let useq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        let hu = has_h.then(|| json!({"value": hd, "version": hn}));
        let bu = has_b.then(|| json!({"value": bd, "version": bn}));
        app.hub.emit_update(&s.user_id, events::update_artifact_update(id, useq, hu, bu), Filter::UserScopedOnly, None);
        let mut o = Map::new();
        o.insert("result".into(), json!("success"));
        if has_h {
            o.insert("header".into(), json!({"version": hn, "data": hd}));
        }
        if has_b {
            o.insert("body".into(), json!({"version": bn, "data": bd}));
        }
        cb.call(Value::Object(o))
    }
    .await;
    artifact_guard("artifact-update", &cb, r).await;
}

async fn artifact_create(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, "artifact-create");
        let d = args.j(0);
        d.destructure()?;
        let (id, header, body, dek) = (d.get("id"), d.get("header"), d.get("body"), d.get("dataEncryptionKey"));
        if !js::truthy(id) || !js::is_string(header) || !js::is_string(body) || !js::is_string(dek) {
            return cb.call_if(json!({"result": "error", "message": "Invalid parameters"}));
        }
        let id = pstr(id)?;
        let existing = sqlx::query(&format!(r#"SELECT {} FROM "Artifact" WHERE "id" = $1"#, ARTIFACT_COLS)).bind(id).fetch_optional(&app.pool).await?;
        if let Some(row) = existing {
            let a = Artifact::from_row(&row);
            if a.account_id != s.user_id {
                return cb.call_if(json!({"result": "error", "message": "Artifact with this ID already exists for another account"}));
            }
            return cb.call(json!({"result": "success", "artifact": a.socket_json()}));
        }
        let (h, b, k) = (b64(header.unwrap().as_str().unwrap())?, b64(body.unwrap().as_str().unwrap())?, b64(dek.unwrap().as_str().unwrap())?);
        let now = db::now();
        let row = sqlx::query(&format!(
            r#"INSERT INTO "Artifact" ("id","accountId","header","headerVersion","body","bodyVersion","dataEncryptionKey","seq","createdAt","updatedAt")
               VALUES ($1,$2,$3,1,$4,1,$5,0,$6,$6) RETURNING {}"#,
            ARTIFACT_COLS
        ))
        .bind(id)
        .bind(&s.user_id)
        .bind(&h)
        .bind(&b)
        .bind(&k)
        .bind(now)
        .fetch_one(&app.pool)
        .await?;
        let a = Artifact::from_row(&row);
        let seq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        app.hub.emit_update(&s.user_id, events::new_artifact_update(&a, seq), Filter::UserScopedOnly, None);
        cb.call(json!({"result": "success", "artifact": a.socket_json()}))
    }
    .await;
    artifact_guard("artifact-create", &cb, r).await;
}

async fn artifact_delete(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        count_event(&app, &s, "artifact-delete");
        let d = args.j(0);
        d.destructure()?;
        let id = d.get("artifactId");
        if !js::truthy(id) {
            return cb.call_if(json!({"result": "error", "message": "Invalid parameters"}));
        }
        let id = pstr(id)?;
        if find_artifact(&app, id, &s.user_id).await?.is_none() {
            return cb.call_if(json!({"result": "error", "message": "Artifact not found"}));
        }
        let r = sqlx::query(r#"DELETE FROM "Artifact" WHERE "id" = $1"#).bind(id).execute(&app.pool).await?;
        db::expect_row(r)?;
        let seq = db::allocate_user_seq_pool(&app.pool, &s.user_id).await?;
        app.hub.emit_update(&s.user_id, events::simple_update(seq, "delete-artifact", "artifactId", id), Filter::UserScopedOnly, None);
        cb.call(json!({"result": "success"}))
    }
    .await;
    artifact_guard("artifact-delete", &cb, r).await;
}

// ---------------------------------------------------------------------------
// accessKeyHandler.ts
// ---------------------------------------------------------------------------

async fn access_key_get(app: Arc<App>, s: Arc<SocketHandle>, args: Args) {
    let cb = args.j(1);
    let r: anyhow::Result<()> = async {
        let d = args.j(0);
        d.destructure()?;
        let (sid, mid) = (d.get("sessionId"), d.get("machineId"));
        if !js::truthy(sid) || !js::truthy(mid) {
            return cb.call_if(json!({"ok": false, "error": "Invalid parameters: sessionId and machineId are required"}));
        }
        let (sid, mid) = (pstr(sid)?, pstr(mid)?);
        let session = find_session(&app, sid, &s.user_id).await?;
        let machine = find_machine(&app, &s.user_id, mid).await?;
        if session.is_none() || machine.is_none() {
            return cb.call_if(json!({"ok": false, "error": "Session or machine not found"}));
        }
        let key: Option<(String, i32, chrono::NaiveDateTime, chrono::NaiveDateTime)> = sqlx::query_as(
            r#"SELECT "data","dataVersion","createdAt","updatedAt" FROM "AccessKey" WHERE "accountId" = $1 AND "machineId" = $2 AND "sessionId" = $3"#,
        )
        .bind(&s.user_id)
        .bind(mid)
        .bind(sid)
        .fetch_optional(&app.pool)
        .await?;
        let resp = match key {
            Some((data, ver, c, u)) => json!({"ok": true, "accessKey": {"data": data, "dataVersion": ver, "createdAt": naive_to_ms(c), "updatedAt": naive_to_ms(u)}}),
            None => json!({"ok": true, "accessKey": null}),
        };
        cb.call_if(resp)?;
        tracing::info!(module = "websocket-access-key", "Access key retrieved for session {}, machine {}", sid, mid);
        Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in access-key-get: {}", e);
        if let Err(e) = cb.call_if(json!({"ok": false, "error": "Internal error"})) {
            crashed("access-key-get", &e);
        }
    }
}

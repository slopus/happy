//! Group commit for session messages: the socket `message` handler and
//! `POST /v3/sessions/:id/messages` hand their writes to one writer per session.
//! While a batch is being written, new items queue; the next batch takes the
//! whole queue (no timers, so an idle session writes each message at once).
//!
//! A batch is two round trips: one read (ownership and the localIds already
//! stored) and one atomic statement that takes the session seqs, the account's
//! user seqs and inserts every row. The plan replays the TS handlers one after
//! another in arrival order, so seqs, burned seqs, duplicates and responses come
//! out as the TS server's sequential calls would produce them. Nothing is
//! published before the commit. If the statement fails (a `\u0000` that jsonb
//! rejects, a unique violation, a session deleted meanwhile), it changed nothing
//! and the batch is replayed one item at a time through the original code paths,
//! which give each message exactly the TS error and side effects.
//!
//! The session's and the account's `updatedAt` are bumped once per batch
//! (QUIRKS deviation 9). The rows are locked Session, then Account.

use crate::app::App;
use crate::db;
use crate::events::{new_message_update, Filter};
use crate::history;
use crate::models::Message;
use crate::routes::sessions::{find_session, message_from_row, owns_session, MESSAGE_COLS};
use crate::util::{cuid, naive_to_ms};
use chrono::NaiveDateTime;
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

/// Items per batch (a v3 request is one item of up to 100 messages).
const MAX_ITEMS: usize = 256;

/// A socket `message` event, past its argument checks.
pub struct SocketMessage {
    pub user_id: String,
    pub socket_id: String,
    pub local_id: Option<String>,
    /// `{"t":"encrypted","c":…}` as JSON text.
    pub content: String,
    /// Fires once the message is written (or dropped) and its update sent.
    pub done: oneshot::Sender<()>,
}

/// A `POST /v3/sessions/:id/messages` body, deduplicated by localId (first wins).
pub struct V3Send {
    pub user_id: String,
    pub messages: Vec<(String, String)>,
    pub reply: oneshot::Sender<anyhow::Result<V3Outcome>>,
}

pub enum V3Outcome {
    NotFound,
    Sent(Value),
}

pub enum Item {
    Socket(SocketMessage),
    V3(V3Send),
}

impl Item {
    fn messages(&self) -> usize {
        match self {
            Item::Socket(_) => 1,
            Item::V3(v) => v.messages.len(),
        }
    }
}

/// Pending items per session. An entry exists exactly while its writer task runs.
#[derive(Default)]
pub struct Writers {
    queues: DashMap<String, Vec<Item>>,
}

pub fn submit(app: &Arc<App>, sid: &str, item: Item) {
    match app.writers.queues.entry(sid.to_string()) {
        Entry::Occupied(mut e) => e.get_mut().push(item),
        Entry::Vacant(v) => {
            v.insert(vec![item]);
            tokio::spawn(run(app.clone(), sid.to_string()));
        }
    }
}

async fn run(app: Arc<App>, sid: String) {
    loop {
        if hooks::enabled() {
            hooks::wait_gate(&app, &sid).await;
        }
        let batch: Vec<Item> = match app.writers.queues.entry(sid.clone()) {
            Entry::Occupied(mut e) => {
                if e.get().is_empty() {
                    e.remove();
                    return;
                }
                let q = e.get_mut();
                let n = q.len().min(MAX_ITEMS);
                q.drain(..n).collect()
            }
            Entry::Vacant(_) => return,
        };
        // A panic must not strand the queue: the entry would stay without a task.
        let (a, s) = (app.clone(), sid.clone());
        if let Err(e) = tokio::spawn(async move { process(&a, &s, batch).await }).await {
            tracing::error!(module = "message-writer", "batch for {} panicked: {}", sid, e);
        }
    }
}

/// A row the batch inserts; `slot` is its 1-based offset in the batch's session seqs.
struct NewRow {
    id: String,
    local_id: Option<String>,
    slot: i32,
    content: String,
    at: NaiveDateTime,
}

/// A stored message as `POST /v3` reports it.
#[derive(Clone)]
struct Sent {
    id: String,
    seq: i32,
    local_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl From<&history::PageRow> for Sent {
    fn from(r: &history::PageRow) -> Sent {
        Sent { id: r.id.clone(), seq: r.seq, local_id: r.local_id.clone(), created_at: r.created_at, updated_at: r.updated_at }
    }
}

impl Sent {
    fn json(&self) -> Value {
        json!({"id": self.id, "seq": self.seq, "localId": self.local_id, "createdAt": self.created_at, "updatedAt": self.updated_at})
    }
}

/// A localId already taken: by a stored row, or by a row earlier in this batch.
#[derive(Clone)]
enum Known {
    Stored(Sent),
    Batch(usize),
}

enum Plan {
    /// Not the caller's session: the socket handler returns, v3 answers 404.
    Skip,
    Socket { user_slot: i32, row: Option<usize> },
    V3 { existing: Vec<Known>, created: Vec<usize>, emits: Vec<(usize, i32)> },
}

async fn process(app: &Arc<App>, sid: &str, items: Vec<Item>) {
    let messages: usize = items.iter().map(Item::messages).sum();
    app.metrics.message_batch_size.observe(items.len() as f64);
    match write(app, sid, &items).await {
        Ok(done) => {
            hooks::record(sid, items.len(), messages, false);
            dispatch(app, sid, items, done);
        }
        Err(e) => {
            hooks::record(sid, items.len(), messages, true);
            tracing::debug!(module = "message-writer", "batch of {} for {} failed ({}); replaying one by one", items.len(), sid, e);
            for item in items {
                match item {
                    Item::Socket(m) => socket_single(app, sid, m).await,
                    Item::V3(v) => {
                        let r = v3_single(app, sid, &v.user_id, &v.messages).await;
                        let _ = v.reply.send(r);
                    }
                }
            }
        }
    }
}

struct Written {
    plans: Vec<Plan>,
    rows: Vec<NewRow>,
    /// Inserted rows by index into `rows`.
    stored: Vec<Option<Message>>,
    session_base: i32,
    user_base: i32,
}

async fn write(app: &Arc<App>, sid: &str, items: &[Item]) -> anyhow::Result<Written> {
    // Round trip 1: the owner, and which of the batch's localIds are stored.
    let mut lids: Vec<String> = Vec::new();
    for item in items {
        match item {
            Item::Socket(m) => lids.extend(m.local_id.clone()),
            Item::V3(v) => lids.extend(v.messages.iter().map(|(l, _)| l.clone())),
        }
    }
    // With history offloaded, a localId may be known only from its page (the
    // row is gone): `SessionMessageLocalId` has its seq, the page the rest.
    let found = if history::merging(app) {
        sqlx::query(
            r#"SELECT s."accountId", m."id", m."seq", m."localId", m."createdAt", m."updatedAt", NULL::int4 AS "pagedSeq", NULL::text AS "pagedLocalId"
               FROM "Session" s LEFT JOIN "SessionMessage" m ON m."sessionId" = s."id" AND m."localId" = ANY($2)
               WHERE s."id" = $1
               UNION ALL
               SELECT NULL, NULL, NULL, NULL, NULL, NULL, l."seq", l."localId" FROM "SessionMessageLocalId" l
               WHERE l."sessionId" = $1 AND l."localId" = ANY($2)"#,
        )
    } else {
        sqlx::query(
            r#"SELECT s."accountId", m."id", m."seq", m."localId", m."createdAt", m."updatedAt", NULL::int4 AS "pagedSeq", NULL::text AS "pagedLocalId"
               FROM "Session" s LEFT JOIN "SessionMessage" m ON m."sessionId" = s."id" AND m."localId" = ANY($2)
               WHERE s."id" = $1"#,
        )
    }
    .bind(sid)
    .bind(&lids)
    .fetch_all(&app.pool)
    .await?;
    let owner: Option<String> = found.iter().find_map(|r| r.get::<Option<String>, _>("accountId"));
    let mut known: HashMap<String, Known> = HashMap::new();
    for r in &found {
        let id: Option<String> = r.get("id");
        if let Some(id) = id {
            let s = Sent {
                id,
                seq: r.get("seq"),
                local_id: r.get("localId"),
                created_at: naive_to_ms(r.get("createdAt")),
                updated_at: naive_to_ms(r.get("updatedAt")),
            };
            known.insert(s.local_id.clone().unwrap_or_default(), Known::Stored(s));
        }
    }
    for r in &found {
        if let (Some(seq), Some(l)) = (r.get::<Option<i32>, _>("pagedSeq"), r.get::<Option<String>, _>("pagedLocalId")) {
            if !known.contains_key(&l) {
                let row = history::paged_row(app, sid, &l, seq).await?;
                known.insert(l, Known::Stored(Sent::from(&row)));
            }
        }
    }

    // The TS handlers, one after another.
    let (mut slots, mut user_slots) = (0i32, 0i32);
    let mut rows: Vec<NewRow> = Vec::new();
    let mut plans: Vec<Plan> = Vec::new();
    for item in items {
        let user = match item {
            Item::Socket(m) => &m.user_id,
            Item::V3(v) => &v.user_id,
        };
        if owner.as_deref() != Some(user.as_str()) {
            plans.push(Plan::Skip);
            continue;
        }
        match item {
            Item::Socket(m) => {
                // allocateUserSeq, allocateSessionSeq, then the duplicate check.
                user_slots += 1;
                slots += 1;
                let dup = m.local_id.as_ref().is_some_and(|l| known.contains_key(l));
                let row = if dup {
                    None
                } else {
                    rows.push(NewRow { id: cuid(), local_id: m.local_id.clone(), slot: slots, content: m.content.clone(), at: db::now() });
                    if let Some(l) = &m.local_id {
                        known.insert(l.clone(), Known::Batch(rows.len() - 1));
                    }
                    Some(rows.len() - 1)
                };
                plans.push(Plan::Socket { user_slot: user_slots, row });
            }
            Item::V3(v) => {
                let at = db::now();
                let existing: Vec<Known> = v.messages.iter().filter_map(|(l, _)| known.get(l).cloned()).collect();
                let mut created = Vec::new();
                for (l, c) in &v.messages {
                    if known.contains_key(l) {
                        continue;
                    }
                    slots += 1;
                    rows.push(NewRow { id: cuid(), local_id: Some(l.clone()), slot: slots, content: json!({"t": "encrypted", "c": c}).to_string(), at });
                    created.push(rows.len() - 1);
                }
                for &i in &created {
                    known.insert(rows[i].local_id.clone().unwrap_or_default(), Known::Batch(i));
                }
                // Created rows are already in seq order; empty content is not published.
                let mut emits = Vec::new();
                for &i in &created {
                    let l = rows[i].local_id.as_deref().unwrap_or_default();
                    if v.messages.iter().find(|(x, _)| x == l).is_some_and(|(_, c)| !c.is_empty()) {
                        user_slots += 1;
                        emits.push((i, user_slots));
                    }
                }
                plans.push(Plan::V3 { existing, created, emits });
            }
        }
    }
    if slots == 0 {
        return Ok(Written { plans, rows, stored: vec![], session_base: 0, user_base: 0 });
    }

    // Round trip 2, one atomic statement. `s` runs first (both others read it),
    // so the Session row is locked before the Account row.
    let now = db::now();
    let r = sqlx::query(&format!(
        r#"WITH s AS (
               UPDATE "Session" SET "seq" = "seq" + $2, "updatedAt" = $3 WHERE "id" = $1 RETURNING "seq"
           ), a AS (
               UPDATE "Account" SET "seq" = "seq" + $5, "updatedAt" = $3
               WHERE "id" = $4 AND $5 > 0 AND EXISTS (SELECT 1 FROM s) RETURNING "seq"
           ), ins AS (
               INSERT INTO "SessionMessage" ("id","sessionId","localId","seq","content","createdAt","updatedAt")
               SELECT t.id, $1, t.lid, s."seq" - $2 + t.slot, t.content::jsonb, t.at, t.at
               FROM s CROSS JOIN UNNEST($6::text[], $7::text[], $8::int4[], $9::text[], $10::timestamp[]) AS t(id, lid, slot, content, at)
               RETURNING {MESSAGE_COLS}
           )
           SELECT (SELECT "seq" FROM s) AS "sessionEnd", (SELECT "seq" FROM a) AS "userEnd", ins.* FROM (SELECT 1) AS one LEFT JOIN ins ON true"#
    ))
    .bind(sid)
    .bind(slots)
    .bind(now)
    .bind(owner.as_deref().unwrap_or_default())
    .bind(user_slots)
    .bind(rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.local_id.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.slot).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.content.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.at).collect::<Vec<_>>())
    .fetch_all(&app.pool)
    .await?;
    let session_end: Option<i32> = r.first().and_then(|x| x.get("sessionEnd"));
    let Some(session_end) = session_end else {
        // The session went away after the read; nothing was written.
        return Err(db::RecordNotFound.into());
    };
    let user_end: Option<i32> = r.first().and_then(|x| x.get("userEnd"));
    if user_slots > 0 && user_end.is_none() {
        // Committed without user seqs: only possible without the Account row (FK).
        anyhow::bail!("account {:?} not found for session {}", owner, sid);
    }
    let mut by_id: HashMap<String, Message> = r
        .iter()
        .filter(|x| x.try_get::<Option<String>, _>("id").ok().flatten().is_some())
        .map(|x| {
            let m = message_from_row(x);
            (m.id.clone(), m)
        })
        .collect();
    let stored = rows.iter().map(|row| by_id.remove(&row.id)).collect();
    Ok(Written { plans, rows, stored, session_base: session_end - slots, user_base: user_end.unwrap_or(0) - user_slots })
}

fn dispatch(app: &Arc<App>, sid: &str, items: Vec<Item>, w: Written) {
    let sent = |i: usize| -> Sent {
        match &w.stored[i] {
            Some(m) => Sent { id: m.id.clone(), seq: m.seq, local_id: m.local_id.clone(), created_at: m.created_at, updated_at: m.updated_at },
            None => {
                let r = &w.rows[i];
                let ms = naive_to_ms(r.at);
                Sent { id: r.id.clone(), seq: w.session_base + r.slot, local_id: r.local_id.clone(), created_at: ms, updated_at: ms }
            }
        }
    };
    for (item, plan) in items.into_iter().zip(w.plans.iter()) {
        match (item, plan) {
            (Item::Socket(m), Plan::Skip) => {
                let _ = m.done.send(());
            }
            (Item::V3(v), Plan::Skip) => {
                let _ = v.reply.send(Ok(V3Outcome::NotFound));
            }
            (Item::Socket(m), Plan::Socket { user_slot, row }) => {
                if let Some(Some(msg)) = row.map(|i| &w.stored[i]) {
                    let payload = new_message_update(&msg.json(), sid, w.user_base + user_slot);
                    app.hub.emit_update(&m.user_id, payload, Filter::Session(sid), Some(&m.socket_id));
                }
                let _ = m.done.send(());
            }
            (Item::V3(v), Plan::V3 { existing, created, emits }) => {
                let content: HashMap<&str, &str> = v.messages.iter().map(|(l, c)| (l.as_str(), c.as_str())).collect();
                for &(i, user_slot) in emits {
                    let s = sent(i);
                    let c = s.local_id.as_deref().and_then(|l| content.get(l)).copied().unwrap_or_default();
                    let msg = json!({
                        "id": s.id,
                        "seq": s.seq,
                        "content": {"t": "encrypted", "c": c},
                        "localId": s.local_id,
                        "createdAt": s.created_at,
                        "updatedAt": s.updated_at,
                    });
                    app.hub.emit_update(&v.user_id, new_message_update(&msg, sid, w.user_base + user_slot), Filter::Session(sid), None);
                }
                let mut all: Vec<Sent> = existing
                    .iter()
                    .map(|k| match k {
                        Known::Stored(s) => s.clone(),
                        Known::Batch(i) => sent(*i),
                    })
                    .chain(created.iter().map(|&i| sent(i)))
                    .collect();
                all.sort_by_key(|m| m.seq);
                let _ = v.reply.send(Ok(V3Outcome::Sent(json!({"messages": all.iter().map(Sent::json).collect::<Vec<_>>()}))));
            }
            _ => unreachable!("plan does not match its item"),
        }
    }
}

/// The socket handler's own statements (`sessionUpdateHandler.ts`): used when a
/// batch fails, so a bad message burns its seqs and fails exactly as in TS.
async fn socket_single(app: &Arc<App>, sid: &str, m: SocketMessage) {
    let r: anyhow::Result<()> = async {
        if find_session(app, sid, &m.user_id).await?.is_none() {
            return Ok(());
        }
        let upd_seq = db::allocate_user_seq_pool(&app.pool, &m.user_id).await?;
        let msg_seq = {
            let mut c = app.pool.acquire().await?;
            db::allocate_session_seq_batch(&mut c, sid, 1).await?[0]
        };
        if let Some(l) = &m.local_id {
            let sql = if history::merging(app) {
                r#"SELECT "id" FROM "SessionMessage" WHERE "sessionId" = $1 AND "localId" = $2
                   UNION ALL SELECT "localId" FROM "SessionMessageLocalId" WHERE "sessionId" = $1 AND "localId" = $2 LIMIT 1"#
            } else {
                r#"SELECT "id" FROM "SessionMessage" WHERE "sessionId" = $1 AND "localId" = $2 LIMIT 1"#
            };
            let existing: Option<(String,)> = sqlx::query_as(sql).bind(sid).bind(l).fetch_optional(&app.pool).await?;
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
        .bind(&m.content)
        .bind(&m.local_id)
        .bind(now)
        .fetch_one(&app.pool)
        .await?;
        let msg = message_from_row(&row);
        app.hub.emit_update(&m.user_id, new_message_update(&msg.json(), sid, upd_seq), Filter::Session(sid), Some(&m.socket_id));
        Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!(module = "websocket", "Error in message handler: {}", e);
    }
    let _ = m.done.send(());
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

/// `POST /v3/sessions/:id/messages` on its own (`v3SessionRoutes.ts`), for a failed batch.
async fn v3_single(app: &Arc<App>, sid: &str, uid: &str, unique: &[(String, String)]) -> anyhow::Result<V3Outcome> {
    if !owns_session(app, sid, uid).await? {
        return Ok(V3Outcome::NotFound);
    }
    let content_by_local: HashMap<String, String> = unique.iter().cloned().collect();
    let (s, unique, merging) = (sid.to_string(), unique.to_vec(), history::merging(app));
    let (mut existing, paged, created) = db::tx(&app.pool, move |c| {
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
            // localIds whose rows live only in history pages (read after commit).
            let paged: Vec<(String, i32)> = if merging {
                sqlx::query_as(r#"SELECT "localId","seq" FROM "SessionMessageLocalId" WHERE "sessionId" = $1 AND "localId" = ANY($2)"#)
                    .bind(&s)
                    .bind(&local_ids)
                    .fetch_all(&mut *c)
                    .await?
                    .into_iter()
                    .filter(|(l, _): &(String, i32)| !existing.iter().any(|e| e.local_id.as_deref() == Some(l.as_str())))
                    .collect()
            } else {
                vec![]
            };
            let new: Vec<&(String, String)> = unique
                .iter()
                .filter(|(l, _)| !existing.iter().any(|e| e.local_id.as_deref() == Some(l.as_str())) && !paged.iter().any(|(p, _)| p == l))
                .collect();
            let seqs = db::allocate_session_seq_batch(&mut *c, &s, new.len() as i32).await?;
            let mut created: Vec<Sent> = Vec::new();
            if !new.is_empty() {
                let now = db::now();
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
            Ok((existing, paged, created))
        })
    })
    .await?;
    for (l, seq) in paged {
        existing.push(Sent::from(&history::paged_row(app, sid, &l, seq).await?));
    }

    let mut created = created;
    created.sort_by_key(|m| m.seq);
    let to_emit: Vec<&Sent> = created.iter().filter(|m| m.local_id.as_ref().and_then(|l| content_by_local.get(l)).is_some_and(|c| !c.is_empty())).collect();
    if !to_emit.is_empty() {
        // One allocation for the whole request: the same consecutive user seqs the
        // TS server hands out one by one, in the same message order.
        let first = db::allocate_user_seq_batch(&app.pool, uid, to_emit.len() as i32).await?;
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
            app.hub.emit_update(uid, new_message_update(&msg, sid, first + i as i32), Filter::Session(sid), None);
        }
    }
    let mut all: Vec<&Sent> = existing.iter().chain(created.iter()).collect();
    all.sort_by_key(|m| m.seq);
    Ok(V3Outcome::Sent(json!({"messages": all.iter().map(|m| m.json()).collect::<Vec<_>>()})))
}

/// Test-only hooks (`HAPPY_RS_TEST_HOOKS=1`), for the batching scenario: hold a
/// session's next batch until a given number of items is queued, and report the
/// batches written.
pub mod hooks {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::LazyLock;

    static ENABLED: LazyLock<bool> = LazyLock::new(|| std::env::var("HAPPY_RS_TEST_HOOKS").is_ok_and(|v| v == "1"));
    static GATES: LazyLock<Mutex<HashMap<String, usize>>> = LazyLock::new(Default::default);
    static BATCHES: LazyLock<Mutex<HashMap<String, Vec<Value>>>> = LazyLock::new(Default::default);

    pub fn enabled() -> bool {
        *ENABLED
    }

    pub fn set_gate(sid: &str, items: usize) {
        GATES.lock().insert(sid.to_string(), items);
    }

    pub fn queued(app: &App, sid: &str) -> usize {
        app.writers.queues.get(sid).map(|q| q.len()).unwrap_or(0)
    }

    pub fn batches(sid: &str) -> Vec<Value> {
        BATCHES.lock().get(sid).cloned().unwrap_or_default()
    }

    pub(super) fn record(sid: &str, items: usize, messages: usize, replayed: bool) {
        if enabled() {
            BATCHES.lock().entry(sid.to_string()).or_default().push(json!({"items": items, "messages": messages, "replayed": replayed}));
        }
    }

    /// Waits (polling; test-only) until the gate's item count is queued, then lifts it.
    pub(super) async fn wait_gate(app: &App, sid: &str) {
        loop {
            let Some(need) = GATES.lock().get(sid).copied() else { return };
            if queued(app, sid) >= need {
                GATES.lock().remove(sid);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    }
}

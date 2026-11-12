//! History offload (`HISTORY_OFFLOAD`): old session messages as pages in object
//! storage.
//!
//! A page holds the rows of one session with seq in [startSeq, endSeq]. Pages of a
//! session follow each other (the next starts at the previous endSeq + 1; burned
//! seqs leave gaps inside them) and only cover a seq prefix whose every row is
//! older than `HISTORY_DB_RETENTION`, so a page never gains a row later (messages
//! are immutable and seqs only grow). Writing a page: row `pending`, PUT, GET
//! back and compare with the rows, then `verified` plus its localIds in one
//! transaction. A mismatch marks it `bad`, which stops that session's offload.
//! A `pending` page left by a crash is finished (or rebuilt) on the next pass.
//!
//! - `shadow`: pages are written while every row stays in Postgres; reads are
//!   served from Postgres and checked against the pages off the response path.
//! - `retain`: the rows of a verified page past the window are deleted (the page
//!   becomes `offloaded`) and reads merge Postgres with the offloaded pages.
//!   Reads merge in any mode once an offloaded page exists; `rehydrate` puts the
//!   rows back.
//!
//! The job runs in this process; the instance advisory lock makes it the only
//! writer. It is throttled (`HISTORY_OFFLOAD_ROWS_PER_SEC`, `_CONCURRENCY`,
//! `HISTORY_RETAIN_ROWS_PER_SEC`, `HISTORY_SCAN_PAUSE`).
//!
//! Object keys: `history/<prefix>/<startSeq>-<endSeq>.json.zst`, the prefix an
//! HMAC of the session id under a key derived from `HANDY_MASTER_SECRET` (session
//! ids are not secret). `SessionMessagePage.objectKey` is the key of record; the
//! derivation only names new pages and the prefix to clean up. Keys are never
//! sent to clients or logged: logs name the session and seq range.

use crate::app::App;
use crate::db;
use crate::models::Message;
use crate::routes::sessions::{message_from_row, MESSAGE_COLS};
use crate::util::{cuid, ms_to_naive, now_ms};
use anyhow::{bail, Context};
use futures_util::stream::{self, StreamExt};
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Shadow,
    Retain,
}

#[derive(Clone, Debug)]
pub struct HistoryConfig {
    pub mode: Mode,
    pub retention: Duration,
    /// Minimum age of a paged row whatever the retention: a writer that allocates a
    /// seq and inserts its row in separate statements (the TS server) may commit a
    /// lower seq after a higher one.
    pub settle: Duration,
    pub page_rows: usize,
    pub page_bytes: usize,
    pub rows_per_sec: f64,
    pub retain_rows_per_sec: f64,
    pub concurrency: usize,
    pub interval: Duration,
    /// Pause between chunks of 100 sessions in a pass.
    pub scan_pause: Duration,
    pub verify_interval: Duration,
    pub verify_sample: i64,
    pub cache_bytes: usize,
    /// Bucket for pages (default: `S3_BUCKET`).
    pub bucket: Option<String>,
}

/// `3d`, `12h`, `30m`, `45s`, `500ms`, or plain seconds.
pub fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let n: u64 = s[..split].parse().ok()?;
    let ms = match &s[split..] {
        "" | "s" => n * 1000,
        "ms" => n,
        "m" => n * 60_000,
        "h" => n * 3_600_000,
        "d" => n * 86_400_000,
        _ => return None,
    };
    Some(Duration::from_millis(ms))
}

impl HistoryConfig {
    pub fn from_env() -> anyhow::Result<HistoryConfig> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let dur = |k: &str, d: &str| -> anyhow::Result<Duration> {
            let v = var(k).unwrap_or_else(|| d.to_string());
            parse_duration(&v).with_context(|| format!("{}: invalid duration {:?}", k, v))
        };
        let num = |k: &str, d: f64| -> anyhow::Result<f64> {
            match var(k) {
                None => Ok(d),
                Some(v) => v.parse::<f64>().ok().filter(|n| *n > 0.0).with_context(|| format!("{}: invalid number {:?}", k, v)),
            }
        };
        let mode = match var("HISTORY_OFFLOAD").as_deref().unwrap_or("off") {
            "off" => Mode::Off,
            "shadow" => Mode::Shadow,
            "retain" => Mode::Retain,
            v => bail!("HISTORY_OFFLOAD: expected off, shadow or retain, got {:?}", v),
        };
        Ok(HistoryConfig {
            mode,
            retention: dur("HISTORY_DB_RETENTION", "3d")?,
            settle: dur("HISTORY_OFFLOAD_SETTLE", "1m")?,
            page_rows: num("HISTORY_PAGE_MAX_ROWS", 1000.0)? as usize,
            page_bytes: num("HISTORY_PAGE_MAX_BYTES", 4.0 * 1024.0 * 1024.0)? as usize,
            rows_per_sec: num("HISTORY_OFFLOAD_ROWS_PER_SEC", 500.0)?,
            retain_rows_per_sec: num("HISTORY_RETAIN_ROWS_PER_SEC", 500.0)?,
            concurrency: num("HISTORY_OFFLOAD_CONCURRENCY", 1.0)? as usize,
            interval: dur("HISTORY_OFFLOAD_INTERVAL", "5m")?,
            scan_pause: dur("HISTORY_SCAN_PAUSE", "200ms")?,
            verify_interval: dur("HISTORY_VERIFY_INTERVAL", "10m")?,
            verify_sample: num("HISTORY_VERIFY_SAMPLE", 20.0)? as i64,
            cache_bytes: num("HISTORY_CACHE_BYTES", 64.0 * 1024.0 * 1024.0)? as usize,
            bucket: var("HISTORY_S3_BUCKET"),
        })
    }
}

// ---------------------------------------------------------------------------
// Page format and keys
// ---------------------------------------------------------------------------

/// A `SessionMessage` row exactly as the message routes return it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRow {
    pub id: String,
    pub seq: i32,
    #[serde(rename = "localId")]
    pub local_id: Option<String>,
    /// `content::text`, the jsonb as Postgres renders it.
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

impl From<&Message> for PageRow {
    fn from(m: &Message) -> PageRow {
        PageRow { id: m.id.clone(), seq: m.seq, local_id: m.local_id.clone(), content: m.content.clone(), created_at: m.created_at, updated_at: m.updated_at }
    }
}

impl From<&PageRow> for Message {
    fn from(r: &PageRow) -> Message {
        Message { id: r.id.clone(), seq: r.seq, local_id: r.local_id.clone(), content: r.content.clone(), created_at: r.created_at, updated_at: r.updated_at }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageFile {
    pub v: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "startSeq")]
    pub start_seq: i32,
    #[serde(rename = "endSeq")]
    pub end_seq: i32,
    pub rows: Vec<PageRow>,
}

pub fn encode(p: &PageFile) -> anyhow::Result<Vec<u8>> {
    Ok(zstd::encode_all(&serde_json::to_vec(p)?[..], 3)?)
}

pub fn decode(bytes: &[u8]) -> anyhow::Result<PageFile> {
    Ok(serde_json::from_slice(&zstd::decode_all(bytes)?)?)
}

/// The key under which session prefixes are computed.
pub fn prefix_key(master_secret: &str) -> [u8; 64] {
    crate::auth::derive_secure_key(master_secret, "happy history object key")
}

/// A session's directory in the store: hex HMAC-SHA256 of its id.
pub fn session_prefix(key: &[u8; 64], sid: &str) -> String {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac key");
    m.update(sid.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

/// The key of a new page.
pub fn object_key(key: &[u8; 64], sid: &str, start: i32, end: i32) -> String {
    format!("history/{}/{}-{}.json.zst", session_prefix(key, sid), start, end)
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ---------------------------------------------------------------------------
// Object store: the S3 bucket, or DATA_DIR/history (outside the public /files tree)
// ---------------------------------------------------------------------------

pub struct Store {
    s3: Option<(crate::storage::s3::S3, String)>,
    dir: PathBuf,
}

impl Store {
    pub fn new(c: &crate::config::Config) -> Store {
        Store {
            s3: c.s3.as_ref().map(|s| (crate::storage::s3::S3::new(s), c.history.bucket.clone().unwrap_or_else(|| s.bucket.clone()))),
            dir: c.data_dir.join("history"),
        }
    }

    fn path(&self, key: &str) -> anyhow::Result<PathBuf> {
        let rel = key.strip_prefix("history/").context("history key")?;
        if rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
            bail!("invalid history key");
        }
        Ok(self.dir.join(rel))
    }

    pub async fn put(&self, key: &str, data: Vec<u8>) -> anyhow::Result<()> {
        match &self.s3 {
            Some((s3, bucket)) => s3.put_object(bucket, key, data).await?,
            None => {
                let p = self.path(key)?;
                tokio::fs::create_dir_all(p.parent().context("parent")?).await?;
                let tmp = p.with_extension("tmp");
                tokio::fs::write(&tmp, data).await?;
                tokio::fs::rename(tmp, p).await?;
            }
        }
        Ok(())
    }

    /// `None` when the object does not exist.
    pub async fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        match &self.s3 {
            Some((s3, bucket)) => match s3.get_object(bucket, key).await {
                Ok(b) => Ok(Some(b)),
                Err(crate::storage::s3::S3Error::NotFound) => Ok(None),
                Err(e) => Err(e.into()),
            },
            None => match tokio::fs::read(self.path(key)?).await {
                Ok(b) => Ok(Some(b)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
        }
    }

    /// The given keys, then whatever else is under `history/<prefix>/`.
    pub async fn delete(&self, keys: &[String], prefix: &str) -> anyhow::Result<()> {
        let dir = format!("history/{}/", prefix);
        self.path(&format!("{}x", dir))?; // validates the prefix as a path segment
        match &self.s3 {
            Some((s3, bucket)) => {
                let mut all: Vec<String> = keys.to_vec();
                all.extend(s3.list_objects(bucket, &dir).await?.into_iter().filter(|k| k.starts_with(&dir)));
                all.sort();
                all.dedup();
                for chunk in all.chunks(100) {
                    s3.remove_objects(bucket, chunk).await?;
                }
            }
            None => {
                for k in keys {
                    match tokio::fs::remove_file(self.path(k)?).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                match tokio::fs::remove_dir_all(self.dir.join(prefix)).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct History {
    pub store: Store,
    /// `prefix_key(HANDY_MASTER_SECRET)`.
    key: [u8; 64],
    cache: Mutex<Cache>,
    /// Throttles: the earliest time the next page may be written / deleted.
    next_slot: tokio::sync::Mutex<Instant>,
    delete_slot: tokio::sync::Mutex<Instant>,
    /// Old rows not yet paged, per session (see `sweep`).
    backlog: Mutex<HashMap<String, i64>>,
    /// Reads merge offloaded pages: retain mode, or an offloaded page existed at
    /// startup.
    merge: AtomicBool,
    /// Test-only (`hold`): no more row deletion; held while a deletion runs.
    hold: AtomicBool,
    deleting: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, (Arc<PageFile>, usize, u64)>,
    bytes: usize,
    tick: u64,
}

impl History {
    pub fn new(c: &crate::config::Config) -> History {
        History {
            store: Store::new(c),
            key: prefix_key(&c.master_secret),
            cache: Default::default(),
            next_slot: tokio::sync::Mutex::new(Instant::now()),
            delete_slot: tokio::sync::Mutex::new(Instant::now()),
            backlog: Default::default(),
            merge: AtomicBool::new(c.history.mode == Mode::Retain),
            hold: AtomicBool::new(false),
            deleting: tokio::sync::Mutex::new(()),
        }
    }
}

fn cfg(app: &App) -> &HistoryConfig {
    &app.config.history
}

pub fn merging(app: &App) -> bool {
    app.history.merge.load(Ordering::Relaxed)
}

/// Startup: reads merge pages whenever some rows live only in pages, whatever the
/// mode (after `retain`, `shadow` or `off` must still serve that history).
pub async fn init(app: &App) -> anyhow::Result<()> {
    let mode = cfg(app).mode;
    match sqlx::query_scalar::<_, bool>(r#"SELECT EXISTS (SELECT 1 FROM "SessionMessagePage" WHERE "state" = 'offloaded')"#).fetch_one(&app.pool).await {
        Ok(true) => {
            app.history.merge.store(true, Ordering::Relaxed);
            if mode != Mode::Retain {
                tracing::warn!(module = "history", "HISTORY_OFFLOAD={:?} but some history lives only in pages: reads merge them (run `rehydrate` to put the rows back)", mode);
            }
        }
        Ok(false) => {}
        // Not migrated yet: fine while the offload is off.
        Err(e) if mode == Mode::Off => tracing::debug!(module = "history", "history tables not readable: {}", e),
        Err(e) => return Err(anyhow::Error::from(e).context("history offload: the SessionMessagePage table is required")),
    }
    Ok(())
}

/// Rows created before this (ms) may be paged.
fn cutoff_ms(c: &HistoryConfig) -> i64 {
    now_ms() - c.retention.max(c.settle).as_millis() as i64
}

async fn page_cached(app: &App, p: &PageRec) -> anyhow::Result<Arc<PageFile>> {
    {
        let mut c = app.history.cache.lock();
        c.tick += 1;
        let t = c.tick;
        if let Some(e) = c.entries.get_mut(&p.key) {
            e.2 = t;
            return Ok(e.0.clone());
        }
    }
    let bytes = get_object(app, &p.key).await?.with_context(|| format!("page {} is missing", p))?;
    if sha256_hex(&bytes) != p.sha {
        bail!("page {} does not match its sha256", p);
    }
    let page = Arc::new(decode(&bytes)?);
    let size = page.rows.iter().map(|r| r.content.len() + r.id.len() + 64).sum::<usize>() + 128;
    let mut c = app.history.cache.lock();
    let limit = cfg(app).cache_bytes;
    while c.bytes + size > limit && !c.entries.is_empty() {
        let oldest = c.entries.iter().min_by_key(|(_, e)| e.2).map(|(k, _)| k.clone()).unwrap();
        if let Some(e) = c.entries.remove(&oldest) {
            c.bytes -= e.1;
        }
    }
    if size <= limit {
        c.tick += 1;
        let t = c.tick;
        c.bytes += size;
        c.entries.insert(p.key.clone(), (page.clone(), size, t));
    }
    Ok(page)
}

async fn get_object(app: &App, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let r = app.history.store.get(key).await;
    if r.is_err() {
        app.metrics.history_storage_errors.with_label_values(&["get"]).inc();
    }
    r
}

async fn put_object(app: &App, key: &str, data: Vec<u8>) -> anyhow::Result<()> {
    let r = app.history.store.put(key, data).await;
    if r.is_err() {
        app.metrics.history_storage_errors.with_label_values(&["put"]).inc();
    }
    r
}

/// Test-only crash points (`HAPPY_RS_TEST_HOOKS=1`, `HAPPY_RS_OFFLOAD_CRASH=<name>`).
fn crash_point(name: &str) {
    if crate::writer::hooks::enabled() && std::env::var("HAPPY_RS_OFFLOAD_CRASH").is_ok_and(|v| v == name) {
        tracing::error!(module = "history", "test crash point {}", name);
        std::process::exit(86);
    }
}

// ---------------------------------------------------------------------------
// Rows and page records
// ---------------------------------------------------------------------------

fn row(r: &sqlx::postgres::PgRow) -> PageRow {
    PageRow::from(&message_from_row(r))
}

async fn rows_in(c: &mut sqlx::PgConnection, sid: &str, start: i32, end: i32) -> anyhow::Result<Vec<PageRow>> {
    Ok(sqlx::query(&format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" BETWEEN $2 AND $3 ORDER BY "seq", "id""#, MESSAGE_COLS))
        .bind(sid)
        .bind(start)
        .bind(end)
        .fetch_all(c)
        .await?
        .iter()
        .map(row)
        .collect())
}

async fn rows_in_pool(app: &App, sid: &str, start: i32, end: i32) -> anyhow::Result<Vec<PageRow>> {
    let mut c = app.pool.acquire().await?;
    rows_in(&mut c, sid, start, end).await
}

async fn session_exists(app: &App, sid: &str) -> anyhow::Result<bool> {
    let r: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "id" = $1"#).bind(sid).fetch_optional(&app.pool).await?;
    Ok(r.is_some())
}

#[derive(Clone, Debug, Deserialize)]
struct PageRec {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "startSeq")]
    start: i32,
    #[serde(rename = "endSeq")]
    end: i32,
    count: i32,
    #[serde(rename = "objectKey")]
    key: String,
    #[serde(rename = "sha256")]
    sha: String,
    state: String,
    #[serde(rename = "maxCreatedMs")]
    max_created: i64,
}

/// In logs and errors: never the object key.
impl std::fmt::Display for PageRec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "of session {} seq {}-{}", self.session_id, self.start, self.end)
    }
}

const PAGE_COLS: &str =
    r#""id","sessionId","startSeq","endSeq","count","objectKey","sha256","state",(extract(epoch FROM "maxCreatedAt") * 1000)::int8 AS "maxCreatedMs""#;

fn page_rec(r: &sqlx::postgres::PgRow) -> PageRec {
    PageRec {
        id: r.get("id"),
        session_id: r.get("sessionId"),
        start: r.get("startSeq"),
        end: r.get("endSeq"),
        count: r.get("count"),
        key: r.get("objectKey"),
        sha: r.get("sha256"),
        state: r.get("state"),
        max_created: r.get("maxCreatedMs"),
    }
}

// ---------------------------------------------------------------------------
// Writing and verifying pages
// ---------------------------------------------------------------------------

enum Check {
    Ok,
    /// The object is not there (a crash before or during its PUT).
    Missing,
    Mismatch(String),
    SessionGone,
}

/// The object on its own: present, its sha256, header and row count.
async fn check_object(app: &App, p: &PageRec) -> anyhow::Result<Result<PageFile, Check>> {
    let Some(bytes) = get_object(app, &p.key).await? else {
        return Ok(Err(if session_exists(app, &p.session_id).await? { Check::Missing } else { Check::SessionGone }));
    };
    if sha256_hex(&bytes) != p.sha {
        return Ok(Err(Check::Mismatch(format!("sha256 differs from the page row ({} bytes)", bytes.len()))));
    }
    let file = match decode(&bytes) {
        Ok(f) => f,
        Err(e) => return Ok(Err(Check::Mismatch(format!("undecodable: {}", e)))),
    };
    if file.v != 1 || file.session_id != p.session_id || file.start_seq != p.start || file.end_seq != p.end {
        return Ok(Err(Check::Mismatch("header differs".into())));
    }
    if file.rows.len() != p.count as usize {
        return Ok(Err(Check::Mismatch(format!("{} rows, page row says {}", file.rows.len(), p.count))));
    }
    Ok(Ok(file))
}

/// The stored object against the session's rows in the page's range.
async fn check_page(app: &App, p: &PageRec) -> anyhow::Result<Check> {
    let db_rows = rows_in_pool(app, &p.session_id, p.start, p.end).await?;
    let file = match check_object(app, p).await? {
        Ok(f) => f,
        Err(c) => return Ok(c),
    };
    if db_rows.is_empty() && !session_exists(app, &p.session_id).await? {
        return Ok(Check::SessionGone);
    }
    if file.rows != db_rows {
        let at = file.rows.iter().zip(db_rows.iter()).position(|(a, b)| a != b).unwrap_or(file.rows.len().min(db_rows.len()));
        let seq = file.rows.get(at).or(db_rows.get(at)).map(|r| r.seq);
        return Ok(Check::Mismatch(format!("rows differ at seq {:?} (page {} rows, db {} rows)", seq, file.rows.len(), db_rows.len())));
    }
    Ok(Check::Ok)
}

async fn mark_verified(app: &App, p: &PageRec) -> anyhow::Result<()> {
    let p = p.clone();
    db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let r = sqlx::query(r#"UPDATE "SessionMessagePage" SET "state" = 'verified', "verifiedAt" = $2 WHERE "id" = $1 AND "state" = 'pending'"#)
                .bind(&p.id)
                .bind(db::now())
                .execute(&mut *c)
                .await?;
            if r.rows_affected() == 1 {
                sqlx::query(
                    r#"INSERT INTO "SessionMessageLocalId" ("sessionId","localId","seq")
                       SELECT "sessionId","localId","seq" FROM "SessionMessage"
                       WHERE "sessionId" = $1 AND "seq" BETWEEN $2 AND $3 AND "localId" IS NOT NULL
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(&p.session_id)
                .bind(p.start)
                .bind(p.end)
                .execute(&mut *c)
                .await?;
            }
            Ok(())
        })
    })
    .await
}

async fn mark_bad(app: &App, p: &PageRec, why: &str, source: &str) -> anyhow::Result<()> {
    sqlx::query(r#"UPDATE "SessionMessagePage" SET "state" = 'bad' WHERE "id" = $1"#).bind(&p.id).execute(&app.pool).await?;
    app.metrics.history_pages.with_label_values(&["bad"]).inc();
    tracing::error!(module = "history", "page {} is bad ({}): {}", p, source, why);
    sync_blocked(app).await;
    Ok(())
}

/// A deleted session's pages: objects (by their stored keys, then anything else
/// under the session's prefix), then the index rows. A page row is inserted
/// before its object is written, so no rows means no objects.
pub async fn forget_session(app: &App, sid: &str) -> anyhow::Result<()> {
    let keys: Vec<String> = sqlx::query_scalar(r#"SELECT "objectKey" FROM "SessionMessagePage" WHERE "sessionId" = $1"#).bind(sid).fetch_all(&app.pool).await?;
    if !keys.is_empty() {
        if let Err(e) = app.history.store.delete(&keys, &session_prefix(&app.history.key, sid)).await {
            app.metrics.history_storage_errors.with_label_values(&["delete"]).inc();
            return Err(e);
        }
        sqlx::query(r#"DELETE FROM "SessionMessagePage" WHERE "sessionId" = $1"#).bind(sid).execute(&app.pool).await?;
        let keys: HashSet<String> = keys.into_iter().collect();
        app.history.cache.lock().entries.retain(|k, _| !keys.contains(k));
    }
    sqlx::query(r#"DELETE FROM "SessionMessageLocalId" WHERE "sessionId" = $1"#).bind(sid).execute(&app.pool).await?;
    Ok(())
}

/// Finishes a `pending` page under its stored key: PUTs it again if the object is
/// missing, then verifies.
async fn finish_page(app: &App, p: &PageRec) -> anyhow::Result<()> {
    let mut p = p.clone();
    match check_page(app, &p).await? {
        Check::Ok => {}
        Check::SessionGone => return forget_session(app, &p.session_id).await,
        Check::Mismatch(why) => return mark_bad(app, &p, &why, "write").await,
        Check::Missing => {
            let rows = rows_in_pool(app, &p.session_id, p.start, p.end).await?;
            let bytes = encode(&PageFile { v: 1, session_id: p.session_id.clone(), start_seq: p.start, end_seq: p.end, rows })?;
            p.sha = sha256_hex(&bytes);
            sqlx::query(r#"UPDATE "SessionMessagePage" SET "sha256" = $2, "bytes" = $3 WHERE "id" = $1"#)
                .bind(&p.id)
                .bind(&p.sha)
                .bind(bytes.len() as i32)
                .execute(&app.pool)
                .await?;
            put_object(app, &p.key, bytes).await?;
            match check_page(app, &p).await? {
                Check::Ok => {}
                Check::SessionGone => return forget_session(app, &p.session_id).await,
                Check::Missing => bail!("page {} still missing after PUT", p),
                Check::Mismatch(why) => return mark_bad(app, &p, &why, "rewrite").await,
            }
        }
    }
    crash_point("before_verified");
    mark_verified(app, &p).await?;
    app.metrics.history_pages.with_label_values(&["verified"]).inc();
    Ok(())
}

async fn throttle(slot: &tokio::sync::Mutex<Instant>, rate: f64, rows: usize) {
    let wait = {
        let mut next = slot.lock().await;
        let now = Instant::now();
        let start = (*next).max(now);
        *next = start + Duration::from_secs_f64(rows as f64 / rate);
        start.saturating_duration_since(now)
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

/// Offloads one session as far as its eligible prefix goes.
async fn offload_session(app: &App, sid: &str) -> anyhow::Result<()> {
    let c = cfg(app);
    // A pending page is the recovery pass's; a bad one stops the session.
    let blocked: Option<(String,)> =
        sqlx::query_as(r#"SELECT "state" FROM "SessionMessagePage" WHERE "sessionId" = $1 AND "state" IN ('pending', 'bad') LIMIT 1"#)
            .bind(sid)
            .fetch_optional(&app.pool)
            .await?;
    if blocked.is_some() {
        return Ok(());
    }
    let last: Option<i32> = sqlx::query_scalar(r#"SELECT max("endSeq") FROM "SessionMessagePage" WHERE "sessionId" = $1"#).bind(sid).fetch_one(&app.pool).await?;
    let mut last_end = last.unwrap_or(0);
    loop {
        let cutoff = cutoff_ms(c);
        let fetched: Vec<PageRow> = sqlx::query(&format!(
            r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" > $2 ORDER BY "seq", "id" LIMIT $3"#,
            MESSAGE_COLS
        ))
        .bind(sid)
        .bind(last_end)
        .bind(c.page_rows as i64 + 1)
        .fetch_all(&app.pool)
        .await?
        .iter()
        .map(row)
        .collect();
        // The eligible prefix: stop at the first row inside the window (createdAt is
        // not always monotonic in seq), at the byte cap, or at the row cap. A page
        // holds every row of each seq in its range (seq is not unique in the
        // schema), so the caps cut only between seqs, and a run of equal seqs cut
        // by a young row or by the fetch limit is left for the next page.
        let mut rows: Vec<PageRow> = Vec::new();
        let mut bytes = 0usize;
        let mut young = false;
        let mut cut = false;
        for r in fetched.iter() {
            let same = rows.last().is_some_and(|l: &PageRow| l.seq == r.seq);
            if r.created_at >= cutoff {
                young = true;
                cut = same;
                break;
            }
            let size = r.content.len() + r.id.len() + r.local_id.as_ref().map_or(0, |l| l.len()) + 96;
            if !same && !rows.is_empty() && (rows.len() >= c.page_rows || bytes + size > c.page_bytes) {
                break;
            }
            bytes += size;
            rows.push(r.clone());
        }
        if !young && rows.len() > c.page_rows {
            cut = true;
        }
        if cut {
            let seq = rows.last().map(|r| r.seq);
            while rows.last().is_some_and(|r| Some(r.seq) == seq) {
                rows.pop();
            }
            if rows.is_empty() && !young {
                tracing::warn!(module = "history", "session {}: more than {} rows share seq {:?}; not paged", sid, c.page_rows, seq);
            }
        }
        if rows.is_empty() {
            return Ok(());
        }
        let n = rows.len();
        // More of this session may be eligible when the page ended at a cap.
        let more = !young && n < fetched.len();
        throttle(&app.history.next_slot, c.rows_per_sec, n).await;
        let (start, end) = (last_end + 1, rows.last().unwrap().seq);
        if !write_page(app, sid, start, end, rows).await? {
            return Ok(());
        }
        app.history.backlog.lock().entry(sid.to_string()).and_modify(|b| *b = (*b - n as i64).max(0));
        sync_backlog(app);
        last_end = end;
        if !more {
            return Ok(());
        }
    }
}

/// Returns false when the page could not be finished (left pending or marked bad).
async fn write_page(app: &App, sid: &str, start: i32, end: i32, rows: Vec<PageRow>) -> anyhow::Result<bool> {
    let min_created = rows.iter().map(|r| r.created_at).min().unwrap_or(0);
    let max_created = rows.iter().map(|r| r.created_at).max().unwrap_or(0);
    let count = rows.len() as i32;
    let bytes = encode(&PageFile { v: 1, session_id: sid.to_string(), start_seq: start, end_seq: end, rows })?;
    let p = PageRec {
        id: cuid(),
        session_id: sid.to_string(),
        start,
        end,
        count,
        key: object_key(&app.history.key, sid, start, end),
        sha: sha256_hex(&bytes),
        state: "pending".into(),
        max_created,
    };
    let inserted = sqlx::query(
        r#"INSERT INTO "SessionMessagePage" ("id","sessionId","startSeq","endSeq","count","objectKey","bytes","sha256","minCreatedAt","maxCreatedAt","state","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) ON CONFLICT ("sessionId","startSeq") DO NOTHING"#,
    )
    .bind(&p.id)
    .bind(sid)
    .bind(start)
    .bind(end)
    .bind(count)
    .bind(&p.key)
    .bind(bytes.len() as i32)
    .bind(&p.sha)
    .bind(ms_to_naive(min_created))
    .bind(ms_to_naive(max_created))
    .bind(db::now())
    .execute(&app.pool)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Ok(false);
    }
    crash_point("after_pending");
    let len = bytes.len();
    put_object(app, &p.key, bytes).await?;
    app.metrics.history_pages.with_label_values(&["written"]).inc();
    app.metrics.history_bytes.inc_by(len as u64);
    crash_point("after_put");
    finish_page(app, &p).await?;
    crash_point("after_verify");
    let state: Option<String> = sqlx::query_scalar(r#"SELECT "state" FROM "SessionMessagePage" WHERE "id" = $1"#).bind(&p.id).fetch_optional(&app.pool).await?;
    Ok(state.as_deref() == Some("verified"))
}

/// Pending pages from an earlier run (a crash between the steps of `write_page`).
async fn recover_pending(app: &App) -> anyhow::Result<()> {
    let pending: Vec<PageRec> = sqlx::query(&format!(r#"SELECT {} FROM "SessionMessagePage" WHERE "state" = 'pending' ORDER BY "createdAt" LIMIT 100"#, PAGE_COLS))
        .fetch_all(&app.pool)
        .await?
        .iter()
        .map(page_rec)
        .collect();
    for p in pending {
        if let Err(e) = finish_page(app, &p).await {
            tracing::warn!(module = "history", "pending page {} not finished: {}", p, e);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Retain: deleting the rows of verified pages past the window
// ---------------------------------------------------------------------------

/// Deletes, page by page in seq order, the rows of the session's verified pages
/// whose every row is older than the retention window. Never in a session with a
/// bad page.
async fn retain_session(app: &App, sid: &str) -> anyhow::Result<()> {
    let c = cfg(app);
    loop {
        let next: Vec<PageRec> =
            sqlx::query(&format!(r#"SELECT {} FROM "SessionMessagePage" WHERE "sessionId" = $1 AND "state" <> 'offloaded' ORDER BY "startSeq""#, PAGE_COLS))
                .bind(sid)
                .fetch_all(&app.pool)
                .await?
                .iter()
                .map(page_rec)
                .collect();
        if next.iter().any(|p| p.state == "bad") {
            return Ok(());
        }
        let cutoff = now_ms() - c.retention.as_millis() as i64;
        let Some(p) = next.into_iter().next().filter(|p| p.state == "verified" && p.max_created < cutoff) else {
            return Ok(());
        };
        throttle(&app.history.delete_slot, c.retain_rows_per_sec, p.count as usize).await;
        // The object must still match the rows it replaces.
        match check_page(app, &p).await? {
            Check::Ok => {}
            Check::SessionGone => return forget_session(app, sid).await,
            Check::Missing => return mark_bad(app, &p, "object missing", "retain").await,
            Check::Mismatch(why) => return mark_bad(app, &p, &why, "retain").await,
        }
        let _deleting = app.history.deleting.lock().await;
        if app.history.hold.load(Ordering::Relaxed) {
            return Ok(());
        }
        match delete_rows(app, &p, cutoff).await {
            Ok(Some(n)) => {
                crash_point("retain_after_commit");
                app.history.merge.store(true, Ordering::Relaxed);
                app.metrics.history_pages.with_label_values(&["offloaded"]).inc();
                app.metrics.history_rows_deleted.inc_by(n);
            }
            Ok(None) => return Ok(()),
            Err(e) => {
                mark_bad(app, &p, &format!("{:#}", e), "retain").await?;
                return Ok(());
            }
        }
    }
}

/// One transaction: re-checks the page (still verified, no bad page in the
/// session, old enough), deletes its rows and marks it offloaded. `None` if the
/// re-check fails; an error (rolled back) if the rows deleted are not the page's.
async fn delete_rows(app: &App, p: &PageRec, cutoff: i64) -> anyhow::Result<Option<u64>> {
    let p = p.clone();
    db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let ok: Option<bool> = sqlx::query_scalar(
                r#"SELECT p."state" = 'verified' AND p."maxCreatedAt" < $2
                          AND NOT EXISTS (SELECT 1 FROM "SessionMessagePage" b WHERE b."sessionId" = p."sessionId" AND b."state" = 'bad')
                   FROM "SessionMessagePage" p WHERE p."id" = $1 FOR UPDATE"#,
            )
            .bind(&p.id)
            .bind(ms_to_naive(cutoff))
            .fetch_optional(&mut *c)
            .await?;
            if ok != Some(true) {
                return Ok(None);
            }
            let n = sqlx::query(r#"DELETE FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" BETWEEN $2 AND $3"#)
                .bind(&p.session_id)
                .bind(p.start)
                .bind(p.end)
                .execute(&mut *c)
                .await?
                .rows_affected();
            crash_point("retain_in_tx");
            if n != p.count as u64 {
                bail!("deleting the page's rows removed {} rows, the page holds {}", n, p.count);
            }
            sqlx::query(r#"UPDATE "SessionMessagePage" SET "state" = 'offloaded', "offloadedAt" = $2 WHERE "id" = $1"#)
                .bind(&p.id)
                .bind(db::now())
                .execute(&mut *c)
                .await?;
            Ok(Some(n))
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/// One pass over all sessions (keyset by id, in chunks of 100 with a pause in
/// between), offloading each and, in retain mode, deleting what may go.
///
/// The backlog gauge is the old rows past the last page of every session whose
/// next row is old (rows behind a young one wait for it and are not counted). It
/// is per session and updated as the pass reaches it, so during the first pass it
/// covers only the sessions seen so far.
async fn sweep(app: &App) -> anyhow::Result<()> {
    recover_pending(app).await?;
    sync_blocked(app).await;
    let c = cfg(app);
    let retain = c.mode == Mode::Retain;
    let mut after = String::new();
    loop {
        let cutoff = ms_to_naive(cutoff_ms(c));
        let retain_cutoff = ms_to_naive(now_ms() - c.retention.as_millis() as i64);
        // Per session: the last paged seq, then (only if the session has messages
        // past it and the first of them is old) how many old rows are past it; and
        // in retain mode whether a verified page is past the window.
        let chunk: Vec<(String, i64, bool)> = sqlx::query_as(
            r#"SELECT s."id", CASE WHEN s."seq" > l."last" AND (
                       SELECT m."createdAt" < $2 FROM "SessionMessage" m
                       WHERE m."sessionId" = s."id" AND m."seq" > l."last" ORDER BY m."seq" LIMIT 1)
                   THEN (SELECT count(*) FROM "SessionMessage" m
                         WHERE m."sessionId" = s."id" AND m."seq" > l."last" AND m."createdAt" < $2)
                   ELSE 0 END,
                   $3 AND EXISTS (SELECT 1 FROM "SessionMessagePage" p
                                  WHERE p."sessionId" = s."id" AND p."state" = 'verified' AND p."maxCreatedAt" < $4)
               FROM "Session" s
               CROSS JOIN LATERAL (SELECT COALESCE(max(p."endSeq"), 0) AS "last" FROM "SessionMessagePage" p WHERE p."sessionId" = s."id") l
               WHERE s."id" > $1 ORDER BY s."id" LIMIT 100"#,
        )
        .bind(&after)
        .bind(cutoff)
        .bind(retain)
        .bind(retain_cutoff)
        .fetch_all(&app.pool)
        .await?;
        let Some(last) = chunk.last() else { break };
        let (from, to) = (std::mem::replace(&mut after, last.0.clone()), last.0.clone());
        {
            let mut b = app.history.backlog.lock();
            b.retain(|k, _| *k <= from || *k > to);
            b.extend(chunk.iter().filter(|(_, n, _)| *n > 0).map(|(s, n, _)| (s.clone(), *n)));
        }
        sync_backlog(app);
        let todo: Vec<String> = chunk.into_iter().filter(|(_, n, d)| *n > 0 || *d).map(|(s, _, _)| s).collect();
        stream::iter(todo)
            .for_each_concurrent(c.concurrency, |sid| async move {
                if let Err(e) = offload_session(app, &sid).await {
                    tracing::warn!(module = "history", "offload of session {} stopped: {}", sid, e);
                }
                if retain {
                    if let Err(e) = retain_session(app, &sid).await {
                        tracing::warn!(module = "history", "retain of session {} stopped: {}", sid, e);
                    }
                }
            })
            .await;
        tokio::time::sleep(c.scan_pause).await;
    }
    // Sessions past the last one (deleted since the previous pass).
    app.history.backlog.lock().retain(|k, _| *k <= after);
    sync_backlog(app);
    sync_blocked(app).await;
    Ok(())
}

fn sync_backlog(app: &App) {
    let rows: i64 = app.history.backlog.lock().values().sum();
    app.metrics.history_backlog.set(rows);
}

/// Sessions with a bad page: their offload (and deletion) has stopped.
async fn sync_blocked(app: &App) {
    match sqlx::query_scalar::<_, i64>(r#"SELECT count(DISTINCT "sessionId") FROM "SessionMessagePage" WHERE "state" = 'bad'"#).fetch_one(&app.pool).await {
        Ok(n) => app.metrics.history_sessions_blocked.set(n),
        Err(e) => tracing::warn!(module = "history", "blocked sessions count failed: {}", e),
    }
}

/// Re-reads a sample of pages: verified ones against the database, offloaded ones
/// on their own (their rows are gone).
async fn verify_sample(app: &App) -> anyhow::Result<()> {
    let start = cuid();
    let sample = cfg(app).verify_sample;
    let q = |cmp: &str| format!(r#"SELECT {} FROM "SessionMessagePage" WHERE "state" IN ('verified', 'offloaded') AND "id" {} $1 ORDER BY "id" LIMIT $2"#, PAGE_COLS, cmp);
    let mut pages: Vec<PageRec> = sqlx::query(&q(">=")).bind(&start).bind(sample).fetch_all(&app.pool).await?.iter().map(page_rec).collect();
    if (pages.len() as i64) < sample {
        let more: Vec<PageRec> =
            sqlx::query(&q("<")).bind(&start).bind(sample - pages.len() as i64).fetch_all(&app.pool).await?.iter().map(page_rec).collect();
        pages.extend(more);
    }
    for p in pages {
        let check = if p.state == "offloaded" {
            match check_object(app, &p).await? {
                Ok(_) => Check::Ok,
                Err(c) => c,
            }
        } else {
            check_page(app, &p).await?
        };
        match check {
            Check::Ok => app.metrics.history_verifier.with_label_values(&["ok"]).inc(),
            Check::SessionGone => forget_session(app, &p.session_id).await?,
            Check::Missing if p.state == "offloaded" => {
                // The only copy: no state change would help; reads of it fail.
                app.metrics.history_verifier.with_label_values(&["mismatch"]).inc();
                tracing::error!(module = "history", "offloaded page {} is missing", p);
            }
            Check::Mismatch(why) if p.state == "offloaded" => {
                app.metrics.history_verifier.with_label_values(&["mismatch"]).inc();
                tracing::error!(module = "history", "offloaded page {} is damaged: {}", p, why);
            }
            Check::Missing => {
                app.metrics.history_verifier.with_label_values(&["mismatch"]).inc();
                mark_bad(app, &p, "object missing", "verifier").await?;
            }
            Check::Mismatch(why) => {
                app.metrics.history_verifier.with_label_values(&["mismatch"]).inc();
                mark_bad(app, &p, &why, "verifier").await?;
            }
        }
    }
    Ok(())
}

pub fn spawn(app: &Arc<App>) {
    if cfg(app).mode == Mode::Off {
        return;
    }
    tracing::info!(module = "history", "history offload: {:?}, retention {:?}", cfg(app).mode, cfg(app).retention);
    let a = app.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = sweep(&a).await {
                tracing::warn!(module = "history", "offload sweep failed: {}", e);
            }
            tokio::time::sleep(cfg(&a).interval).await;
        }
    });
    let a = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(cfg(&a).verify_interval).await;
            if let Err(e) = verify_sample(&a).await {
                tracing::warn!(module = "history", "page verifier failed: {}", e);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Reads: Postgres merged with offloaded pages
// ---------------------------------------------------------------------------

const META_SELECT: &str =
    r#"SELECT "id","sessionId","startSeq","endSeq","count","objectKey","sha256","state",(extract(epoch FROM "maxCreatedAt") * 1000)::int8 AS "maxCreatedMs" FROM "SessionMessagePage""#;

/// The rows query and the offloaded pages that may hold more of its result, in one
/// statement (one snapshot: a page turns offloaded in the same transaction that
/// deletes its rows, and back in the one that restores them).
async fn merged(app: &App, rows_sql: &str, pages_sql: &str, sid: &str, bound: Option<i64>, take: i64) -> anyhow::Result<(Vec<Message>, Vec<PageRec>)> {
    let sql = format!(
        r#"WITH r AS ({}) SELECT r.*, (SELECT COALESCE(json_agg(p), '[]')::text FROM ({}) p) AS "pages" FROM (SELECT 1) AS one LEFT JOIN r ON true"#,
        rows_sql, pages_sql
    );
    let mut q = sqlx::query(&sql).bind(sid);
    if let Some(b) = bound {
        q = q.bind(b);
    }
    let found = q.bind(take).fetch_all(&app.pool).await?;
    let pages: Vec<PageRec> = match found.first() {
        Some(r) => serde_json::from_str(&r.get::<String, _>("pages"))?,
        None => vec![],
    };
    let rows = found.iter().filter(|r| r.get::<Option<String>, _>("id").is_some()).map(message_from_row).collect();
    Ok((rows, pages))
}

/// v3 `GET /messages`: up to `take` rows with seq above `after` (ascending), or
/// below `before` (descending).
pub async fn read_seq(app: &App, sid: &str, before: Option<i64>, after: i64, take: i64) -> anyhow::Result<Vec<Message>> {
    let desc = before.is_some();
    let bound = before.unwrap_or(after);
    let rows_sql = if desc {
        format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" < $2 ORDER BY "seq" DESC LIMIT $3"#, MESSAGE_COLS)
    } else {
        format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" > $2 ORDER BY "seq" ASC LIMIT $3"#, MESSAGE_COLS)
    };
    if !merging(app) {
        return Ok(sqlx::query(&rows_sql).bind(sid).bind(bound).bind(take).fetch_all(&app.pool).await?.iter().map(message_from_row).collect());
    }
    // Every page holds at least one row, and only the first may straddle the
    // bound (and hold none past it), so the first `take` + 1 pages are enough.
    let pages_sql = if desc {
        format!(r#"{} WHERE "sessionId" = $1 AND "state" = 'offloaded' AND "startSeq" < $2 ORDER BY "startSeq" DESC LIMIT $3 + 1"#, META_SELECT)
    } else {
        format!(r#"{} WHERE "sessionId" = $1 AND "state" = 'offloaded' AND "endSeq" > $2 ORDER BY "startSeq" LIMIT $3 + 1"#, META_SELECT)
    };
    let (mut rows, mut pages) = merged(app, &rows_sql, &pages_sql, sid, Some(bound), take).await?;
    let key = |seq: i32| if desc { -(seq as i64) } else { seq as i64 };
    rows.sort_by_key(|m| key(m.seq));
    pages.sort_by_key(|p| key(if desc { p.end } else { p.start }));
    let n = take.max(0) as usize;
    let mut ids: HashSet<String> = rows.iter().map(|m| m.id.clone()).collect();
    for p in pages {
        if n > 0 && rows.len() >= n && key(if desc { p.end } else { p.start }) > key(rows[n - 1].seq) {
            break;
        }
        let file = page_cached(app, &p).await?;
        for r in &file.rows {
            let inside = if desc { (r.seq as i64) < bound } else { (r.seq as i64) > bound };
            // A row still in Postgres wins.
            if inside && ids.insert(r.id.clone()) {
                rows.push(Message::from(r));
            }
        }
        rows.sort_by_key(|m| key(m.seq));
    }
    rows.truncate(n);
    Ok(rows)
}

/// v1 `GET /messages`: the `take` latest rows by (createdAt, seq), descending.
pub async fn read_latest(app: &App, sid: &str, take: i64) -> anyhow::Result<Vec<Message>> {
    let rows_sql = format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC, "seq" DESC LIMIT $2"#, MESSAGE_COLS);
    if !merging(app) {
        return Ok(sqlx::query(&rows_sql).bind(sid).bind(take).fetch_all(&app.pool).await?.iter().map(message_from_row).collect());
    }
    // A page's newest row ranks it; the doubled limit covers ties on createdAt.
    let pages_sql = format!(r#"{} WHERE "sessionId" = $1 AND "state" = 'offloaded' ORDER BY "maxCreatedAt" DESC, "endSeq" DESC LIMIT $2 * 2"#, META_SELECT);
    let (mut rows, mut pages) = merged(app, &rows_sql, &pages_sql, sid, None, take).await?;
    let key = |m: &Message| (std::cmp::Reverse(m.created_at), std::cmp::Reverse(m.seq));
    rows.sort_by_key(key);
    pages.sort_by_key(|p| (std::cmp::Reverse(p.max_created), std::cmp::Reverse(p.end)));
    let n = take.max(0) as usize;
    let mut ids: HashSet<String> = rows.iter().map(|m| m.id.clone()).collect();
    for p in pages {
        if n > 0 && rows.len() >= n && p.max_created < rows[n - 1].created_at {
            break;
        }
        let file = page_cached(app, &p).await?;
        for r in &file.rows {
            if ids.insert(r.id.clone()) {
                rows.push(Message::from(r));
            }
        }
        rows.sort_by_key(key);
    }
    rows.truncate(n);
    Ok(rows)
}

/// A row known only from `SessionMessageLocalId` (its row was deleted), read from
/// the page holding its seq. For the duplicate checks of message writes.
pub async fn paged_row(app: &App, sid: &str, local_id: &str, seq: i32) -> anyhow::Result<PageRow> {
    let p: PageRec = sqlx::query(&format!(
        r#"SELECT {} FROM "SessionMessagePage" WHERE "sessionId" = $1 AND "startSeq" <= $2 AND "endSeq" >= $2 AND "state" IN ('offloaded', 'verified') LIMIT 1"#,
        PAGE_COLS
    ))
    .bind(sid)
    .bind(seq)
    .fetch_optional(&app.pool)
    .await?
    .as_ref()
    .map(page_rec)
    .with_context(|| format!("session {}: no page holds seq {}", sid, seq))?;
    let file = page_cached(app, &p).await?;
    file.rows
        .iter()
        .find(|r| r.seq == seq && r.local_id.as_deref() == Some(local_id))
        .cloned()
        .with_context(|| format!("page {} has no row for its localId at seq {}", p, seq))
}

// ---------------------------------------------------------------------------
// Rehydrate: the rows of offloaded pages back into Postgres
// ---------------------------------------------------------------------------

/// `happy-server-rs rehydrate [--session <id>]`: every offloaded page (of one
/// session) back into `SessionMessage`, one transaction per page, which then is
/// `verified` again. Idempotent and resumable: an interrupted run leaves whole
/// pages done or untouched, and the next run continues.
pub async fn rehydrate(app: &App, session: Option<&str>) -> anyhow::Result<()> {
    if cfg(app).mode == Mode::Retain {
        println!("warning: HISTORY_OFFLOAD=retain here; a server in retain mode deletes the rows again (switch it to shadow or off first)");
    }
    let (done, rows, failed) = rehydrate_pages(app, session, true).await?;
    println!("done: {} pages ({} rows) rehydrated, {} failed", done, rows, failed);
    if failed > 0 {
        bail!("{} pages not rehydrated; run again to retry", failed);
    }
    Ok(())
}

/// (pages, rows, failed pages).
async fn rehydrate_pages(app: &App, session: Option<&str>, print: bool) -> anyhow::Result<(u64, u64, u64)> {
    let (mut done, mut rows, mut failed) = (0u64, 0u64, 0u64);
    let mut after = String::new();
    loop {
        let pages: Vec<PageRec> = sqlx::query(&format!(
            r#"SELECT {} FROM "SessionMessagePage" WHERE "state" = 'offloaded' AND ($1::text IS NULL OR "sessionId" = $1) AND "id" > $2 ORDER BY "id" LIMIT 100"#,
            PAGE_COLS
        ))
        .bind(session)
        .bind(&after)
        .fetch_all(&app.pool)
        .await?
        .iter()
        .map(page_rec)
        .collect();
        let Some(last) = pages.last() else { break };
        after = last.id.clone();
        for p in pages {
            match rehydrate_page(app, &p).await {
                Ok(n) => {
                    done += 1;
                    rows += n;
                }
                Err(e) => {
                    failed += 1;
                    if print {
                        println!("page {}: {:#}", p, e);
                    } else {
                        tracing::warn!(module = "history", "rehydrating page {} failed: {:#}", p, e);
                    }
                }
            }
        }
        if print {
            println!("rehydrated {} pages ({} rows), {} failed", done, rows, failed);
        }
    }
    Ok((done, rows, failed))
}

/// Test-only (`GET /__test/history/hold`, for the compat scenarios that read
/// `SessionMessage` directly): stops row deletion for good and puts every
/// offloaded row back. Reads are unaffected either way.
pub async fn test_hold(app: &App) -> anyhow::Result<u64> {
    app.history.hold.store(true, Ordering::Relaxed);
    let _deleting = app.history.deleting.lock().await;
    let (done, _, failed) = rehydrate_pages(app, None, false).await?;
    if failed > 0 {
        bail!("{} pages not rehydrated", failed);
    }
    Ok(done)
}

async fn rehydrate_page(app: &App, p: &PageRec) -> anyhow::Result<u64> {
    let file = match check_object(app, p).await? {
        Ok(f) => f,
        Err(Check::SessionGone) => return forget_session(app, &p.session_id).await.map(|_| 0),
        Err(Check::Missing) => bail!("object missing"),
        Err(Check::Mismatch(why)) => bail!("{}", why),
        Err(Check::Ok) => unreachable!(),
    };
    let p = p.clone();
    db::tx(&app.pool, move |c| {
        Box::pin(async move {
            let state: Option<String> =
                sqlx::query_scalar(r#"SELECT "state" FROM "SessionMessagePage" WHERE "id" = $1 FOR UPDATE"#).bind(&p.id).fetch_optional(&mut *c).await?;
            if state.as_deref() != Some("offloaded") {
                return Ok(0);
            }
            let n = sqlx::query(
                r#"INSERT INTO "SessionMessage" ("id","sessionId","localId","seq","content","createdAt","updatedAt")
                   SELECT t.id, $1, t.lid, t.seq, t.content::jsonb, t.c, t.u
                   FROM UNNEST($2::text[], $3::text[], $4::int4[], $5::text[], $6::timestamp[], $7::timestamp[]) AS t(id, lid, seq, content, c, u)
                   ON CONFLICT ("id") DO NOTHING"#,
            )
            .bind(&p.session_id)
            .bind(file.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>())
            .bind(file.rows.iter().map(|r| r.local_id.clone()).collect::<Vec<_>>())
            .bind(file.rows.iter().map(|r| r.seq).collect::<Vec<_>>())
            .bind(file.rows.iter().map(|r| r.content.clone()).collect::<Vec<_>>())
            .bind(file.rows.iter().map(|r| ms_to_naive(r.created_at)).collect::<Vec<_>>())
            .bind(file.rows.iter().map(|r| ms_to_naive(r.updated_at)).collect::<Vec<_>>())
            .execute(&mut *c)
            .await?
            .rows_affected();
            crash_point("rehydrate_in_tx");
            let back = rows_in(&mut *c, &p.session_id, p.start, p.end).await?;
            if back != file.rows {
                bail!("rows in the database after the insert differ from the page");
            }
            sqlx::query(r#"UPDATE "SessionMessagePage" SET "state" = 'verified', "offloadedAt" = NULL WHERE "id" = $1"#).bind(&p.id).execute(&mut *c).await?;
            Ok(n)
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Shadow reads
// ---------------------------------------------------------------------------

/// Checks rows a read served against the verified pages covering them, in the
/// background. `contiguous`: the read returned every row between its lowest and
/// highest seq (v3), so page rows missing from it are caught too.
pub fn shadow(app: &Arc<App>, sid: &str, served: &[Message], contiguous: bool) {
    if cfg(app).mode == Mode::Off || served.is_empty() {
        return;
    }
    let (app, sid) = (app.clone(), sid.to_string());
    let served: Vec<PageRow> = served.iter().map(PageRow::from).collect();
    tokio::spawn(async move {
        if let Err(e) = shadow_check(&app, &sid, &served, contiguous).await {
            app.metrics.history_shadow.with_label_values(&["error"]).inc();
            tracing::warn!(module = "history", "shadow read of session {} failed: {}", sid, e);
        }
    });
}

async fn shadow_check(app: &App, sid: &str, served: &[PageRow], contiguous: bool) -> anyhow::Result<()> {
    let lo = served.iter().map(|r| r.seq).min().unwrap();
    let hi = served.iter().map(|r| r.seq).max().unwrap();
    let pages: Vec<PageRec> = sqlx::query(&format!(
        r#"SELECT {} FROM "SessionMessagePage" WHERE "sessionId" = $1 AND "state" = 'verified' AND "endSeq" >= $2 AND "startSeq" <= $3 ORDER BY "startSeq""#,
        PAGE_COLS
    ))
    .bind(sid)
    .bind(lo)
    .bind(hi)
    .fetch_all(&app.pool)
    .await?
    .iter()
    .map(page_rec)
    .collect();
    for p in pages {
        let file = page_cached(app, &p).await?;
        let by_id: HashMap<&str, &PageRow> = file.rows.iter().map(|r| (r.id.as_str(), r)).collect();
        let mut bad: Option<String> = None;
        for r in served.iter().filter(|r| r.seq >= p.start && r.seq <= p.end) {
            match by_id.get(r.id.as_str()) {
                Some(x) if *x == r => {}
                Some(_) => bad = bad.or(Some(format!("seq {} differs", r.seq))),
                None => bad = bad.or(Some(format!("seq {} served but not in the page", r.seq))),
            }
        }
        if contiguous {
            let have: HashSet<&str> = served.iter().map(|r| r.id.as_str()).collect();
            // Strictly inside: a limit may cut a run of equal seqs at either end.
            for r in file.rows.iter().filter(|r| r.seq > lo && r.seq < hi) {
                if !have.contains(r.id.as_str()) {
                    bad = bad.or(Some(format!("seq {} in the page but not served", r.seq)));
                }
            }
        }
        match bad {
            None => app.metrics.history_shadow.with_label_values(&["ok"]).inc(),
            Some(why) => {
                app.metrics.history_shadow.with_label_values(&["mismatch"]).inc();
                tracing::error!(module = "history", "shadow read mismatch: page {}: {}", p, why);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("3d"), Some(Duration::from_secs(3 * 86400)));
        assert_eq!(parse_duration("0s"), Some(Duration::ZERO));
        assert_eq!(parse_duration("250ms"), Some(Duration::from_millis(250)));
        assert_eq!(parse_duration("90"), Some(Duration::from_secs(90)));
        assert_eq!(parse_duration("3w"), None);
    }

    #[test]
    fn page_round_trip() {
        let p = PageFile {
            v: 1,
            session_id: "s".into(),
            start_seq: 1,
            end_seq: 9,
            rows: vec![
                PageRow { id: "a".into(), seq: 2, local_id: None, content: r#"{"c": "x\u0001", "t": "encrypted"}"#.into(), created_at: 1, updated_at: 1 },
                PageRow { id: "b".into(), seq: 9, local_id: Some("l".into()), content: r#"{"c": {"a": [1, 2.50]}, "t": "encrypted"}"#.into(), created_at: 2, updated_at: 3 },
            ],
        };
        assert_eq!(decode(&encode(&p).unwrap()).unwrap(), p);
    }

    /// PBKDF2-SHA512 (210000 rounds, salt "happy history object key"), then
    /// HMAC-SHA256 of the session id (checked with Python's hashlib/hmac).
    #[test]
    fn keyed_prefix() {
        let key = prefix_key("test-master-secret");
        assert_eq!(session_prefix(&key, "cmd8ufq1x0000m3cx2z4dz3e2"), "9a6273966e9ea1d021319ed120bca2a3ccead56237c8689f0f5d7f4e991950ce");
        assert_eq!(object_key(&key, "cmd8ufq1x0000m3cx2z4dz3e2", 1, 9), "history/9a6273966e9ea1d021319ed120bca2a3ccead56237c8689f0f5d7f4e991950ce/1-9.json.zst");
        assert_ne!(session_prefix(&prefix_key("another-secret"), "cmd8ufq1x0000m3cx2z4dz3e2"), session_prefix(&key, "cmd8ufq1x0000m3cx2z4dz3e2"));
    }
}

//! History offload (`HISTORY_OFFLOAD`). Stage A, `shadow`: old messages are copied
//! to object storage as pages while their rows stay in Postgres, and reads check
//! the pages against the rows they serve. Clients never see a page in this mode.
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
//! The job runs in this process; the instance advisory lock makes it the only
//! writer. It is throttled (`HISTORY_OFFLOAD_ROWS_PER_SEC`, `_CONCURRENCY`).

use crate::app::App;
use crate::db;
use crate::models::Message;
use crate::routes::sessions::{message_from_row, MESSAGE_COLS};
use crate::util::{cuid, ms_to_naive, now_ms};
use anyhow::{bail, Context};
use futures_util::stream::{self, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Shadow,
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
    pub concurrency: usize,
    pub interval: Duration,
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
            "retain" => bail!("HISTORY_OFFLOAD=retain is not available yet (stage B); use shadow"),
            v => bail!("HISTORY_OFFLOAD: expected off, shadow or retain, got {:?}", v),
        };
        Ok(HistoryConfig {
            mode,
            retention: dur("HISTORY_DB_RETENTION", "3d")?,
            settle: dur("HISTORY_OFFLOAD_SETTLE", "1m")?,
            page_rows: num("HISTORY_PAGE_MAX_ROWS", 1000.0)? as usize,
            page_bytes: num("HISTORY_PAGE_MAX_BYTES", 4.0 * 1024.0 * 1024.0)? as usize,
            rows_per_sec: num("HISTORY_OFFLOAD_ROWS_PER_SEC", 2000.0)?,
            concurrency: num("HISTORY_OFFLOAD_CONCURRENCY", 2.0)? as usize,
            interval: dur("HISTORY_OFFLOAD_INTERVAL", "5m")?,
            verify_interval: dur("HISTORY_VERIFY_INTERVAL", "10m")?,
            verify_sample: num("HISTORY_VERIFY_SAMPLE", 20.0)? as i64,
            cache_bytes: num("HISTORY_CACHE_BYTES", 64.0 * 1024.0 * 1024.0)? as usize,
            bucket: var("HISTORY_S3_BUCKET"),
        })
    }
}

// ---------------------------------------------------------------------------
// Page format
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

pub fn object_key(sid: &str, start: i32, end: i32) -> String {
    format!("history/{}/{}-{}.json.zst", sid, start, end)
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
            bail!("invalid history key {:?}", key);
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

    /// Every object of a session.
    pub async fn delete_session(&self, sid: &str) -> anyhow::Result<()> {
        let prefix = format!("history/{}/", sid);
        self.path(&format!("{}x", prefix))?; // validates the session id as a path segment
        match &self.s3 {
            Some((s3, bucket)) => {
                let keys: Vec<String> = s3.list_objects(bucket, &prefix).await?.into_iter().filter(|k| k.starts_with(&prefix)).collect();
                for chunk in keys.chunks(100) {
                    s3.remove_objects(bucket, chunk).await?;
                }
            }
            None => match tokio::fs::remove_dir_all(self.dir.join(sid)).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct History {
    pub store: Store,
    cache: Mutex<Cache>,
    /// Global throttle: the earliest time the next page may start.
    next_slot: tokio::sync::Mutex<Instant>,
    /// Old rows not yet paged, per session (see `sweep`).
    backlog: Mutex<HashMap<String, i64>>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, (Arc<PageFile>, usize, u64)>,
    bytes: usize,
    tick: u64,
}

impl History {
    pub fn new(c: &crate::config::Config) -> History {
        History { store: Store::new(c), cache: Default::default(), next_slot: tokio::sync::Mutex::new(Instant::now()), backlog: Default::default() }
    }
}

fn cfg(app: &App) -> &HistoryConfig {
    &app.config.history
}

/// Rows created before this (ms) may be paged.
fn cutoff_ms(c: &HistoryConfig) -> i64 {
    now_ms() - c.retention.max(c.settle).as_millis() as i64
}

async fn page_cached(app: &App, key: &str, sha: &str) -> anyhow::Result<Arc<PageFile>> {
    {
        let mut c = app.history.cache.lock();
        c.tick += 1;
        let t = c.tick;
        if let Some(e) = c.entries.get_mut(key) {
            e.2 = t;
            return Ok(e.0.clone());
        }
    }
    let bytes = get_object(app, key).await?.with_context(|| format!("page object {} is missing", key))?;
    if sha256_hex(&bytes) != sha {
        bail!("page object {} does not match its sha256", key);
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
        c.entries.insert(key.to_string(), (page.clone(), size, t));
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

/// Test-only crash points (`HAPPY_RS_TEST_HOOKS=1`, `HAPPY_RS_OFFLOAD_CRASH=after_pending|after_put|after_verify`).
fn crash_point(name: &str) {
    if crate::writer::hooks::enabled() && std::env::var("HAPPY_RS_OFFLOAD_CRASH").is_ok_and(|v| v == name) {
        tracing::error!(module = "history", "test crash point {}", name);
        std::process::exit(86);
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

fn row(r: &sqlx::postgres::PgRow) -> PageRow {
    PageRow::from(&message_from_row(r))
}

async fn rows_in(app: &App, sid: &str, start: i32, end: i32) -> anyhow::Result<Vec<PageRow>> {
    Ok(sqlx::query(&format!(r#"SELECT {} FROM "SessionMessage" WHERE "sessionId" = $1 AND "seq" BETWEEN $2 AND $3 ORDER BY "seq", "id""#, MESSAGE_COLS))
        .bind(sid)
        .bind(start)
        .bind(end)
        .fetch_all(&app.pool)
        .await?
        .iter()
        .map(row)
        .collect())
}

async fn session_exists(app: &App, sid: &str) -> anyhow::Result<bool> {
    let r: Option<(String,)> = sqlx::query_as(r#"SELECT "id" FROM "Session" WHERE "id" = $1"#).bind(sid).fetch_optional(&app.pool).await?;
    Ok(r.is_some())
}

#[derive(Clone, Debug)]
struct PageRec {
    id: String,
    session_id: String,
    start: i32,
    end: i32,
    count: i32,
    key: String,
    sha: String,
}

const PAGE_COLS: &str = r#""id","sessionId","startSeq","endSeq","count","objectKey","sha256""#;

fn page_rec(r: &sqlx::postgres::PgRow) -> PageRec {
    PageRec {
        id: r.get("id"),
        session_id: r.get("sessionId"),
        start: r.get("startSeq"),
        end: r.get("endSeq"),
        count: r.get("count"),
        key: r.get("objectKey"),
        sha: r.get("sha256"),
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

/// The stored object against the session's rows in the page's range.
async fn check_page(app: &App, p: &PageRec) -> anyhow::Result<Check> {
    let Some(bytes) = get_object(app, &p.key).await? else {
        return Ok(if session_exists(app, &p.session_id).await? { Check::Missing } else { Check::SessionGone });
    };
    let db_rows = rows_in(app, &p.session_id, p.start, p.end).await?;
    if db_rows.is_empty() && !session_exists(app, &p.session_id).await? {
        return Ok(Check::SessionGone);
    }
    if sha256_hex(&bytes) != p.sha {
        return Ok(Check::Mismatch(format!("sha256 differs from the page row ({} bytes)", bytes.len())));
    }
    let file = match decode(&bytes) {
        Ok(f) => f,
        Err(e) => return Ok(Check::Mismatch(format!("undecodable: {}", e))),
    };
    if file.v != 1 || file.session_id != p.session_id || file.start_seq != p.start || file.end_seq != p.end {
        return Ok(Check::Mismatch("header differs".into()));
    }
    if file.rows.len() != p.count as usize {
        return Ok(Check::Mismatch(format!("{} rows, page row says {}", file.rows.len(), p.count)));
    }
    if file.rows != db_rows {
        let at = file.rows.iter().zip(db_rows.iter()).position(|(a, b)| a != b).unwrap_or(file.rows.len().min(db_rows.len()));
        return Ok(Check::Mismatch(format!("rows differ at index {} (page {} rows, db {} rows)", at, file.rows.len(), db_rows.len())));
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
    tracing::error!(module = "history", "page {} of session {} (seq {}-{}) is bad ({}): {}", p.key, p.session_id, p.start, p.end, source, why);
    Ok(())
}

/// A deleted session's pages: objects first, then the index rows. A page row is
/// inserted before its object is written, so no rows means no objects.
pub async fn forget_session(app: &App, sid: &str) -> anyhow::Result<()> {
    let any: Option<i32> = sqlx::query_scalar(r#"SELECT 1 FROM "SessionMessagePage" WHERE "sessionId" = $1 LIMIT 1"#).bind(sid).fetch_optional(&app.pool).await?;
    if any.is_none() {
        sqlx::query(r#"DELETE FROM "SessionMessageLocalId" WHERE "sessionId" = $1"#).bind(sid).execute(&app.pool).await?;
        return Ok(());
    }
    if let Err(e) = app.history.store.delete_session(sid).await {
        app.metrics.history_storage_errors.with_label_values(&["delete"]).inc();
        return Err(e);
    }
    sqlx::query(r#"DELETE FROM "SessionMessagePage" WHERE "sessionId" = $1"#).bind(sid).execute(&app.pool).await?;
    sqlx::query(r#"DELETE FROM "SessionMessageLocalId" WHERE "sessionId" = $1"#).bind(sid).execute(&app.pool).await?;
    app.history.cache.lock().entries.retain(|k, _| !k.starts_with(&format!("history/{}/", sid)));
    Ok(())
}

/// Finishes a `pending` page: PUTs it again if the object is missing, then verifies.
async fn finish_page(app: &App, p: &PageRec) -> anyhow::Result<()> {
    let mut p = p.clone();
    match check_page(app, &p).await? {
        Check::Ok => {}
        Check::SessionGone => return forget_session(app, &p.session_id).await,
        Check::Mismatch(why) => return mark_bad(app, &p, &why, "write").await,
        Check::Missing => {
            let rows = rows_in(app, &p.session_id, p.start, p.end).await?;
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
                Check::Missing => bail!("page object {} still missing after PUT", p.key),
                Check::Mismatch(why) => return mark_bad(app, &p, &why, "rewrite").await,
            }
        }
    }
    crash_point("before_verified");
    mark_verified(app, &p).await?;
    app.metrics.history_pages.with_label_values(&["verified"]).inc();
    Ok(())
}

async fn throttle(app: &App, rows: usize) {
    let wait = {
        let mut next = app.history.next_slot.lock().await;
        let now = Instant::now();
        let start = (*next).max(now);
        *next = start + Duration::from_secs_f64(rows as f64 / cfg(app).rows_per_sec);
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
    let blocked: Option<(String,)> = sqlx::query_as(r#"SELECT "state" FROM "SessionMessagePage" WHERE "sessionId" = $1 AND "state" <> 'verified' LIMIT 1"#)
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
        throttle(app, n).await;
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
    let p = PageRec { id: cuid(), session_id: sid.to_string(), start, end, count, key: object_key(sid, start, end), sha: sha256_hex(&bytes) };
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
            tracing::warn!(module = "history", "pending page {} not finished: {}", p.key, e);
        }
    }
    Ok(())
}

/// One pass over all sessions (keyset by id, in chunks), offloading each.
///
/// The backlog gauge is the old rows past the last page of every session whose
/// next row is old (rows behind a young one wait for it and are not counted). It
/// is per session and updated as the pass reaches it, so during the first pass it
/// covers only the sessions seen so far.
async fn sweep(app: &App) -> anyhow::Result<()> {
    recover_pending(app).await?;
    let c = cfg(app);
    let mut after = String::new();
    loop {
        let cutoff = ms_to_naive(cutoff_ms(c));
        // Per session: the last paged seq, then (only if the session has messages
        // past it and the first of them is old) how many old rows are past it.
        let chunk: Vec<(String, i64)> = sqlx::query_as(
            r#"SELECT s."id", CASE WHEN s."seq" > l."last" AND (
                       SELECT m."createdAt" < $2 FROM "SessionMessage" m
                       WHERE m."sessionId" = s."id" AND m."seq" > l."last" ORDER BY m."seq" LIMIT 1)
                   THEN (SELECT count(*) FROM "SessionMessage" m
                         WHERE m."sessionId" = s."id" AND m."seq" > l."last" AND m."createdAt" < $2)
                   ELSE 0 END
               FROM "Session" s
               CROSS JOIN LATERAL (SELECT COALESCE(max(p."endSeq"), 0) AS "last" FROM "SessionMessagePage" p WHERE p."sessionId" = s."id") l
               WHERE s."id" > $1 ORDER BY s."id" LIMIT 100"#,
        )
        .bind(&after)
        .bind(cutoff)
        .fetch_all(&app.pool)
        .await?;
        let Some(last) = chunk.last() else { break };
        let (from, to) = (std::mem::replace(&mut after, last.0.clone()), last.0.clone());
        {
            let mut b = app.history.backlog.lock();
            b.retain(|k, _| *k <= from || *k > to);
            b.extend(chunk.iter().filter(|(_, n)| *n > 0).cloned());
        }
        sync_backlog(app);
        let todo: Vec<String> = chunk.into_iter().filter(|(_, n)| *n > 0).map(|(s, _)| s).collect();
        stream::iter(todo)
            .for_each_concurrent(c.concurrency, |sid| async move {
                if let Err(e) = offload_session(app, &sid).await {
                    tracing::warn!(module = "history", "offload of session {} stopped: {}", sid, e);
                }
            })
            .await;
    }
    // Sessions past the last one (deleted since the previous pass).
    app.history.backlog.lock().retain(|k, _| *k <= after);
    sync_backlog(app);
    Ok(())
}

fn sync_backlog(app: &App) {
    let rows: i64 = app.history.backlog.lock().values().sum();
    app.metrics.history_backlog.set(rows);
}

/// Re-reads a sample of verified pages against the database.
async fn verify_sample(app: &App) -> anyhow::Result<()> {
    let start = cuid();
    let mut pages: Vec<PageRec> = sqlx::query(&format!(r#"SELECT {} FROM "SessionMessagePage" WHERE "state" = 'verified' AND "id" >= $1 ORDER BY "id" LIMIT $2"#, PAGE_COLS))
        .bind(&start)
        .bind(cfg(app).verify_sample)
        .fetch_all(&app.pool)
        .await?
        .iter()
        .map(page_rec)
        .collect();
    if (pages.len() as i64) < cfg(app).verify_sample {
        let more: Vec<PageRec> = sqlx::query(&format!(r#"SELECT {} FROM "SessionMessagePage" WHERE "state" = 'verified' AND "id" < $1 ORDER BY "id" LIMIT $2"#, PAGE_COLS))
            .bind(&start)
            .bind(cfg(app).verify_sample - pages.len() as i64)
            .fetch_all(&app.pool)
            .await?
            .iter()
            .map(page_rec)
            .collect();
        pages.extend(more);
    }
    for p in pages {
        match check_page(app, &p).await? {
            Check::Ok => app.metrics.history_verifier.with_label_values(&["ok"]).inc(),
            Check::SessionGone => forget_session(app, &p.session_id).await?,
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
// Shadow reads
// ---------------------------------------------------------------------------

/// Checks rows a read served from Postgres against the verified pages covering
/// them, in the background. `contiguous`: the read returned every row between its
/// lowest and highest seq (v3), so page rows missing from it are caught too.
pub fn shadow(app: &Arc<App>, sid: &str, served: &[Message], contiguous: bool) {
    if cfg(app).mode != Mode::Shadow || served.is_empty() {
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
        let file = page_cached(app, &p.key, &p.sha).await?;
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
            let have: std::collections::HashSet<&str> = served.iter().map(|r| r.id.as_str()).collect();
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
                tracing::error!(module = "history", "shadow read mismatch: session {} page {} (seq {}-{}): {}", sid, p.key, p.start, p.end, why);
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
}

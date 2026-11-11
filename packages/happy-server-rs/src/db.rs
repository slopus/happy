//! Postgres access on the existing Prisma schema.
//!
//! Prisma semantics we keep: timestamps are written by the application with
//! millisecond precision (`createdAt`/`updatedAt` are never left to DB defaults),
//! every update bumps `updatedAt`, `inTx` is SERIALIZABLE with three retries on
//! serialization failures, and plain `$transaction` uses the database default.

use crate::util::{ms_to_naive, now_ms};
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{ConnectOptions, Connection, PgConnection, PgPool};
use std::str::FromStr;
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/prisma_migrations.rs"));

/// Advisory lock key held for the life of the process (single-writer guard).
const INSTANCE_LOCK_KEY: i64 = 0x6861_7070_7972_7331; // "happyrs1"

pub fn connect_options(url: &str) -> anyhow::Result<(PgConnectOptions, u32)> {
    // Strip Prisma-only URL parameters; keep the rest for sqlx.
    let mut pool_size = 20u32;
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b.to_string(), q.to_string()),
        None => (url.to_string(), String::new()),
    };
    let mut kept = Vec::new();
    let mut search_path: Option<String> = None;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "connection_limit" => pool_size = v.parse().unwrap_or(pool_size),
            "schema" => search_path = Some(v.to_string()),
            "pool_timeout" | "pgbouncer" | "socket_timeout" | "statement_cache_size" | "sslaccept" | "connect_timeout" => {}
            _ => kept.push(pair.to_string()),
        }
    }
    let url = if kept.is_empty() { base } else { format!("{}?{}", base, kept.join("&")) };
    let mut opts = PgConnectOptions::from_str(&url)?.disable_statement_logging();
    if let Some(s) = search_path {
        opts = opts.options([("search_path", s)]);
    }
    Ok((opts, pool_size))
}

/// `connection_limit` from a Prisma-style URL, if present.
pub fn url_connection_limit(url: &str) -> Option<u32> {
    url.split_once('?')?.1.split('&').find_map(|p| p.strip_prefix("connection_limit=")?.parse().ok())
}

pub async fn connect(url: &str, size: u32) -> anyhow::Result<PgPool> {
    let (opts, _) = connect_options(url)?;
    let pool = PgPoolOptions::new()
        .max_connections(size.max(2))
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Takes the process-lifetime advisory lock on a dedicated connection. Returns the
/// connection, which must be kept alive.
pub async fn acquire_instance_lock(url: &str) -> anyhow::Result<PgConnection> {
    let (opts, _) = connect_options(url)?;
    let mut conn = PgConnection::connect_with(&opts).await?;
    let (ok,): (bool,) = sqlx::query_as("SELECT pg_try_advisory_lock($1)").bind(INSTANCE_LOCK_KEY).fetch_one(&mut conn).await?;
    if !ok {
        anyhow::bail!(
            "another happy-server-rs instance holds the database lock; the in-memory locks, \
             caches and RPC routing assume a single process per database"
        );
    }
    Ok(conn)
}

/// `happy-server-rs migrate`: applies the TS server's own Prisma migrations (fresh
/// DBs/self-host) and records them in `_prisma_migrations` with Prisma's checksums,
/// exactly as `prisma migrate deploy` would. Never run implicitly; the Rust server
/// adds no schema of its own.
pub async fn migrate_prisma(pool: &PgPool) -> anyhow::Result<usize> {
    sqlx::raw_sql(
        r#"CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" VARCHAR(36) PRIMARY KEY NOT NULL,
            "checksum" VARCHAR(64) NOT NULL,
            "finished_at" TIMESTAMPTZ,
            "migration_name" VARCHAR(255) NOT NULL,
            "logs" TEXT,
            "rolled_back_at" TIMESTAMPTZ,
            "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "applied_steps_count" INTEGER NOT NULL DEFAULT 0
        )"#,
    )
    .execute(pool)
    .await?;
    let applied: Vec<(String,)> =
        sqlx::query_as(r#"SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL"#)
            .fetch_all(pool)
            .await?;
    let applied: std::collections::HashSet<String> = applied.into_iter().map(|r| r.0).collect();
    let mut n = 0;
    for (name, sql) in PRISMA_MIGRATIONS {
        if applied.contains(*name) {
            continue;
        }
        let checksum = hex::encode(Sha256::digest(sql.as_bytes()));
        let mut tx = pool.begin().await?;
        sqlx::raw_sql(sql).execute(&mut *tx).await.map_err(|e| anyhow::anyhow!("Failed to apply {}: {}", name, e))?;
        sqlx::query(r#"INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","applied_steps_count") VALUES ($1,$2,now(),$3,1)"#)
            .bind(crate::util::uuid_v4())
            .bind(checksum)
            .bind(*name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        n += 1;
    }
    Ok(n)
}

pub fn pg_code(e: &anyhow::Error) -> Option<String> {
    e.downcast_ref::<sqlx::Error>()
        .and_then(|e| e.as_database_error())
        .and_then(|d| d.code().map(|c| c.to_string()))
}

/// Prisma P2002.
pub fn is_unique_violation(e: &anyhow::Error) -> bool {
    pg_code(e).as_deref() == Some("23505")
}

/// Error Prisma throws when `update`/`delete` find no row (P2025).
#[derive(Debug)]
pub struct RecordNotFound;
impl std::fmt::Display for RecordNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("An operation failed because it depends on one or more records that were required but not found.")
    }
}
impl std::error::Error for RecordNotFound {}

pub fn is_record_not_found(e: &anyhow::Error) -> bool {
    e.downcast_ref::<RecordNotFound>().is_some()
}

/// `inTx`: SERIALIZABLE, retried up to 3 times on serialization failure.
pub async fn in_tx<T, F>(pool: &PgPool, f: F) -> anyhow::Result<T>
where
    F: for<'c> Fn(&'c mut PgConnection) -> BoxFuture<'c, anyhow::Result<T>>,
{
    let mut counter = 0;
    loop {
        let res: anyhow::Result<T> = async {
            let mut tx = pool.begin().await?;
            sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE").execute(&mut *tx).await?;
            let r = f(&mut tx).await?;
            tx.commit().await?;
            Ok(r)
        }
        .await;
        match res {
            Err(e) if matches!(pg_code(&e).as_deref(), Some("40001") | Some("40P01")) && counter < 3 => {
                counter += 1;
                tokio::time::sleep(Duration::from_millis(counter * 100)).await;
            }
            other => return other,
        }
    }
}

/// Prisma `$transaction(async tx => …)` with default isolation.
pub async fn tx<T, F>(pool: &PgPool, f: F) -> anyhow::Result<T>
where
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, anyhow::Result<T>>,
{
    let mut tx = pool.begin().await?;
    let r = f(&mut tx).await?;
    tx.commit().await?;
    Ok(r)
}

/// JS `new Date()` for a statement.
pub fn now() -> chrono::NaiveDateTime {
    ms_to_naive(now_ms())
}

// ---------------------------------------------------------------------------
// Sequence allocation (storage/seq.ts)
// ---------------------------------------------------------------------------

pub async fn allocate_user_seq(c: &mut PgConnection, account_id: &str) -> anyhow::Result<i32> {
    let r: Option<(i32,)> = sqlx::query_as(r#"UPDATE "Account" SET "seq" = "seq" + 1, "updatedAt" = $2 WHERE "id" = $1 RETURNING "seq""#)
        .bind(account_id)
        .bind(now())
        .fetch_optional(c)
        .await?;
    r.map(|r| r.0).ok_or_else(|| RecordNotFound.into())
}

pub async fn allocate_user_seq_pool(pool: &PgPool, account_id: &str) -> anyhow::Result<i32> {
    let mut c = pool.acquire().await?;
    allocate_user_seq(&mut c, account_id).await
}

/// `count` consecutive user seqs in one statement; returns the first.
pub async fn allocate_user_seq_batch(pool: &PgPool, account_id: &str, count: i32) -> anyhow::Result<i32> {
    let r: Option<(i32,)> = sqlx::query_as(r#"UPDATE "Account" SET "seq" = "seq" + $2, "updatedAt" = $3 WHERE "id" = $1 RETURNING "seq""#)
        .bind(account_id)
        .bind(count)
        .bind(now())
        .fetch_optional(pool)
        .await?;
    Ok(r.ok_or(RecordNotFound)?.0 - count + 1)
}

pub async fn allocate_session_seq_batch(c: &mut PgConnection, session_id: &str, count: i32) -> anyhow::Result<Vec<i32>> {
    if count <= 0 {
        return Ok(vec![]);
    }
    let r: Option<(i32,)> = sqlx::query_as(r#"UPDATE "Session" SET "seq" = "seq" + $2, "updatedAt" = $3 WHERE "id" = $1 RETURNING "seq""#)
        .bind(session_id)
        .bind(count)
        .bind(now())
        .fetch_optional(c)
        .await?;
    let end = r.ok_or(RecordNotFound)?.0;
    Ok(((end - count + 1)..=end).collect())
}

/// Prisma `update`/`delete` by unique key: no row is P2025, which throws.
pub fn expect_row(r: sqlx::postgres::PgQueryResult) -> anyhow::Result<()> {
    if r.rows_affected() == 0 {
        return Err(RecordNotFound.into());
    }
    Ok(())
}

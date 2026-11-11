//! `presence/sessionCache.ts` (ActivityCache) on sharded maps.

use crate::metrics::Metrics;
use crate::util::{ms_to_naive, now_ms};
use dashmap::DashMap;
use sqlx::PgPool;
use std::sync::Arc;

const CACHE_TTL: i64 = 30_000;
const UPDATE_THRESHOLD: i64 = 30_000;
const STOPPED_TTL: i64 = 60_000;
pub const BATCH_INTERVAL_MS: u64 = 5_000;
pub const CLEANUP_INTERVAL_MS: u64 = 5 * 60_000;

struct SessionEntry {
    valid_until: i64,
    last_update_sent: i64,
    pending_update: Option<i64>,
    user_id: String,
}

struct MachineEntry {
    valid_until: i64,
    last_update_sent: i64,
    pending_update: Option<i64>,
    user_id: String,
    active: bool,
}

pub struct ActivityCache {
    pool: PgPool,
    metrics: Arc<Metrics>,
    sessions: DashMap<String, SessionEntry>,
    machines: DashMap<String, MachineEntry>,
    stopped: DashMap<String, i64>,
}

impl ActivityCache {
    pub fn new(pool: PgPool, metrics: Arc<Metrics>) -> ActivityCache {
        ActivityCache { pool, metrics, sessions: DashMap::new(), machines: DashMap::new(), stopped: DashMap::new() }
    }

    fn cache_op(&self, op: &str, result: &str) {
        self.metrics.session_cache.with_label_values(&[op, result]).inc();
    }

    fn is_session_stopped(&self, id: &str, now: i64) -> bool {
        let Some(until) = self.stopped.get(id).map(|v| *v) else { return false };
        if until <= now {
            self.stopped.remove_if(id, |_, v| *v <= now);
            return false;
        }
        true
    }

    pub async fn is_session_valid(&self, session_id: &str, user_id: &str) -> bool {
        let now = now_ms();
        if self.is_session_stopped(session_id, now) {
            self.cache_op("session_validation", "stopped");
            return false;
        }
        if let Some(e) = self.sessions.get(session_id) {
            if e.valid_until > now && e.user_id == user_id {
                self.cache_op("session_validation", "hit");
                return true;
            }
        }
        self.cache_op("session_validation", "miss");
        let row: Result<Option<(chrono::NaiveDateTime,)>, _> =
            sqlx::query_as(r#"SELECT "lastActiveAt" FROM "Session" WHERE "id" = $1 AND "accountId" = $2 LIMIT 1"#)
                .bind(session_id)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await;
        match row {
            Ok(Some((last,))) => {
                if self.is_session_stopped(session_id, now_ms()) {
                    self.cache_op("session_validation", "stopped");
                    return false;
                }
                self.sessions.insert(
                    session_id.to_string(),
                    SessionEntry {
                        valid_until: now + CACHE_TTL,
                        last_update_sent: crate::util::naive_to_ms(last),
                        pending_update: None,
                        user_id: user_id.to_string(),
                    },
                );
                true
            }
            Ok(None) => false,
            Err(e) => {
                tracing::error!(module = "session-cache", "Error validating session {}: {}", session_id, e);
                false
            }
        }
    }

    pub async fn is_machine_valid(&self, machine_id: &str, user_id: &str) -> bool {
        let now = now_ms();
        if let Some(e) = self.machines.get(machine_id) {
            if e.valid_until > now && e.user_id == user_id {
                self.cache_op("machine_validation", "hit");
                return true;
            }
        }
        self.cache_op("machine_validation", "miss");
        let row: Result<Option<(chrono::NaiveDateTime, bool)>, _> =
            sqlx::query_as(r#"SELECT "lastActiveAt", "active" FROM "Machine" WHERE "accountId" = $1 AND "id" = $2 LIMIT 1"#)
                .bind(user_id)
                .bind(machine_id)
                .fetch_optional(&self.pool)
                .await;
        match row {
            Ok(Some((last, active))) => {
                self.machines.insert(
                    machine_id.to_string(),
                    MachineEntry {
                        valid_until: now + CACHE_TTL,
                        last_update_sent: crate::util::naive_to_ms(last),
                        pending_update: None,
                        user_id: user_id.to_string(),
                        active,
                    },
                );
                true
            }
            Ok(None) => false,
            Err(e) => {
                tracing::error!(module = "session-cache", "Error validating machine {}: {}", machine_id, e);
                false
            }
        }
    }

    pub fn queue_session_update(&self, session_id: &str, timestamp: i64) -> bool {
        if self.is_session_stopped(session_id, now_ms()) {
            self.metrics.database_updates_skipped.with_label_values(&["session"]).inc();
            return false;
        }
        let Some(mut e) = self.sessions.get_mut(session_id) else { return false };
        if (timestamp - e.last_update_sent).abs() > UPDATE_THRESHOLD {
            e.pending_update = Some(timestamp);
            return true;
        }
        drop(e);
        self.metrics.database_updates_skipped.with_label_values(&["session"]).inc();
        false
    }

    pub fn queue_machine_update(&self, machine_id: &str, timestamp: i64) -> bool {
        let Some(mut e) = self.machines.get_mut(machine_id) else { return false };
        if !e.active || (timestamp - e.last_update_sent).abs() > UPDATE_THRESHOLD {
            e.pending_update = Some(timestamp);
            return true;
        }
        drop(e);
        self.metrics.database_updates_skipped.with_label_values(&["machine"]).inc();
        false
    }

    pub fn clear_session_updates(&self, session_id: &str) {
        self.sessions.remove(session_id);
        self.stopped.insert(session_id.to_string(), now_ms() + STOPPED_TTL);
    }

    pub fn resume_session_updates(&self, session_id: &str) {
        self.stopped.remove(session_id);
    }

    pub async fn flush(&self) {
        // `if (entry.pendingUpdate)`: a 0 timestamp counts as nothing pending.
        let mut sessions = Vec::new();
        for mut e in self.sessions.iter_mut() {
            if let Some(ts) = e.pending_update.take().filter(|t| *t != 0) {
                e.last_update_sent = ts;
                sessions.push((e.key().clone(), ts));
            }
        }
        let mut machines = Vec::new();
        for mut e in self.machines.iter_mut() {
            if let Some(ts) = e.pending_update.take().filter(|t| *t != 0) {
                e.last_update_sent = ts;
                e.active = true;
                machines.push((e.key().clone(), ts, e.user_id.clone()));
            }
        }
        if !sessions.is_empty() {
            let now = crate::db::now();
            let futs = sessions.iter().map(|(id, ts)| {
                sqlx::query(r#"UPDATE "Session" SET "lastActiveAt" = $1, "active" = true, "updatedAt" = $2 WHERE "id" = $3"#)
                    .bind(ms_to_naive(*ts))
                    .bind(now)
                    .bind(id)
                    .execute(&self.pool)
            });
            let results = futures_util::future::join_all(futs).await;
            match first_failure(results.into_iter().map(|r| r.map(|r| r.rows_affected()))) {
                None => tracing::info!(module = "session-cache", "Flushed {} session updates", sessions.len()),
                Some(e) => tracing::error!(module = "session-cache", "Error updating sessions: {}", e),
            }
        }
        if !machines.is_empty() {
            let now = crate::db::now();
            let futs = machines.iter().map(|(id, ts, uid)| {
                sqlx::query(r#"UPDATE "Machine" SET "lastActiveAt" = $1, "active" = true, "updatedAt" = $2 WHERE "accountId" = $3 AND "id" = $4"#)
                    .bind(ms_to_naive(*ts))
                    .bind(now)
                    .bind(uid)
                    .bind(id)
                    .execute(&self.pool)
            });
            let results = futures_util::future::join_all(futs).await;
            match first_failure(results.into_iter().map(|r| r.map(|r| r.rows_affected()))) {
                None => tracing::info!(module = "session-cache", "Flushed {} machine updates", machines.len()),
                Some(e) => tracing::error!(module = "session-cache", "Error updating machines: {}", e),
            }
        }
    }

    pub fn cleanup(&self) {
        let now = now_ms();
        self.sessions.retain(|_, e| e.valid_until >= now);
        self.machines.retain(|_, e| e.valid_until >= now);
        self.stopped.retain(|_, until| *until > now);
    }
}

/// Prisma `update` throws when the row is gone (P2025), failing the `Promise.all`.
fn first_failure(results: impl Iterator<Item = Result<u64, sqlx::Error>>) -> Option<String> {
    for r in results {
        match r {
            Err(e) => return Some(e.to_string()),
            Ok(0) => return Some(crate::db::RecordNotFound.to_string()),
            Ok(_) => {}
        }
    }
    None
}

import { createRequire } from 'node:module';
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { planHistorySchemaMerge, quoteHistoryIdentifier as quote, type HistoryDatabase as Database, type HistoryRow as Row, type HistorySchemaEntry } from './codexHistorySchema';

const filename = 'thread_history_1.sqlite';
const tables = new Set(['_sqlx_migrations', 'thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items']);
function database(path: string, readOnly: boolean, timeout = 5_000): Database {
  // Like Codex attach discovery, the managed Node runtime supplies node:sqlite.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  return new DatabaseSync(path, { readOnly, timeout });
}

/** A WAL-aware read transaction kept open while its corresponding rollouts copy. */
export async function snapshotCodexHistoryIndex(home: string) {
  const path = join(home, filename);
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) throw new Error('Invalid Codex history index');
  let source: Database;
  try { source = database(path, true); }
  catch (error) {
    if ((error as { code?: string }).code === 'ERR_UNKNOWN_BUILTIN_MODULE') throw new Error('Paginated Codex history requires a Node runtime with node:sqlite (use Node 24).');
    throw error;
  }
  try {
    source.exec('BEGIN');
    const schema = source.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all() as HistorySchemaEntry[];
    if (schema.some(row => !tables.has(row.tbl_name))) throw new Error('Unsupported Codex history index schema');
    const tableNames = schema.filter(row => row.type === 'table').map(row => row.name as string);
    let retained = new Map<string, Row>();
    return {
      async prepareDestination(destination: string) {
        const targetPath = join(destination, filename);
        const info = await lstat(targetPath).catch(() => null);
        if (!info) return;
        if (!info.isFile()) throw new Error('Invalid Codex history index destination');
        const target = database(targetPath, false);
        try {
          // Migrate atomically before any rollout is replaced. A rejected schema
          // leaves both the previous index and its rollout bytes untouched.
          target.exec('BEGIN IMMEDIATE');
          for (const statement of planHistorySchemaMerge(source, target, schema, () => database(':memory:', false)).statements) target.exec(statement);
          mergeMigrations(source, target, tableNames);
          target.exec('COMMIT');
          if (target.prepare("SELECT name FROM sqlite_master WHERE name='thread_history_projection_state'").get()) {
            retained = new Map(target.prepare('SELECT * FROM thread_history_projection_state').all().map(row => [row.thread_id, row]));
          }
        } catch (error) {
          try { target.exec('ROLLBACK'); } catch { /* Transaction may already have committed. */ }
          throw error;
        } finally { target.close(); }
      },
      projection(threadId: string) {
        return tableNames.includes('thread_history_projection_state')
          ? source.prepare('SELECT * FROM thread_history_projection_state WHERE thread_id = ?').get(threadId)
          : undefined;
      },
      accepts(threadId: string, size: number) {
        const projected = this.projection(threadId);
        const current = retained.get(threadId);
        if (projected && projected.next_rollout_byte_offset > size) throw new Error('Codex history index is ahead of its rollout');
        return !current || Boolean(projected && projected.next_rollout_ordinal >= current.next_rollout_ordinal);
      },
      close() { source.close(); },
      async restore(destination: string, rollouts: ReadonlyMap<string, number>) {
        const targetPath = join(destination, filename);
        const existing = await lstat(targetPath).catch(() => null);
        if (existing && !existing.isFile()) throw new Error('Invalid Codex history index destination');
        const target = database(targetPath, false);
        try {
          await chmod(targetPath, 0o600);
          target.exec('BEGIN IMMEDIATE');
          const plan = planHistorySchemaMerge(source, target, schema, () => database(':memory:', false));
          for (const statement of plan.statements) target.exec(statement);
          mergeMigrations(source, target, tableNames);
          for (const [threadId, size] of rollouts) {
            const projected = tableNames.includes('thread_history_projection_state')
              ? source.prepare('SELECT * FROM thread_history_projection_state WHERE thread_id = ?').get(threadId)
              : undefined;
            if (!projected) continue;
            if (projected.next_rollout_byte_offset > size) throw new Error('Codex history index is ahead of its rollout');
            const retained = target.prepare('SELECT * FROM thread_history_projection_state WHERE thread_id = ?').get(threadId);
            // A home restored earlier must not rewind a shared account cache.
            if (retained && (retained.next_rollout_ordinal > projected.next_rollout_ordinal
              || (plan.sourceIsOlder && retained.next_rollout_ordinal === projected.next_rollout_ordinal))) continue;
            for (const table of tableNames) {
              if (table === '_sqlx_migrations') continue;
              const rows = source.prepare(`SELECT * FROM ${quote(table)} WHERE thread_id = ?`).all(threadId);
              if (plan.sourceIsOlder) {
                // A still-running old Codex can append after another home has
                // upgraded the cache. Preserve fields it does not know about
                // on existing items, rather than resetting them to defaults.
                const sourceColumns = new Set(source.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().map(column => column.name));
                const columns = target.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
                const extras = columns.filter(column => !sourceColumns.has(column.name));
                if (extras.length) {
                  const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
                  if (!keys.length) throw new Error('Cannot preserve newer Codex history fields without a primary key');
                  const key = (row: Row) => JSON.stringify(keys.map(name => row[name]));
                  const previous = new Map(target.prepare(`SELECT * FROM ${quote(table)} WHERE thread_id = ?`).all(threadId).map(row => [key(row), row]));
                  for (const row of rows) {
                    const existing = previous.get(key(row));
                    if (existing) for (const column of extras) row[column.name] = existing[column.name];
                  }
                }
              }
              target.prepare(`DELETE FROM ${quote(table)} WHERE thread_id = ?`).run(threadId);
              for (const row of rows) insertRow(target, table, row);
            }
          }
          target.exec('COMMIT');
        } catch (error) {
          try { target.exec('ROLLBACK'); } catch { /* No transaction if opening failed. */ }
          throw error;
        } finally { target.close(); }
      },
    };
  } catch (error) { source.close(); throw error; }
}
function insertRow(db: Database, table: string, row: Row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
}

/** SQLite owns this cross-process mutex; a killed worker releases it automatically. */
export async function withCodexHistoryCacheLock<T>(home: string, action: () => Promise<T>): Promise<T> {
  const path = join(home, '.paws-history-copy-lock.sqlite');
  const existing = await lstat(path).catch(() => null);
  if (existing && !existing.isFile()) throw new Error('Invalid Codex history lock');
  let lock: Database;
  try { lock = database(path, false, 0); }
  catch (error) {
    // Node 20 still supports legacy JSONL-only history. Paginated history
    // itself fails explicitly when snapshotCodexHistoryIndex opens its DB.
    if ((error as { code?: string }).code === 'ERR_UNKNOWN_BUILTIN_MODULE') return action();
    throw error;
  }
  try {
    await chmod(path, 0o600);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (![5, 6].includes((error as { errcode?: number }).errcode ?? -1) || Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
    try { return await action(); }
    finally { lock.exec('ROLLBACK'); }
  } finally { lock.close(); }
}

function mergeMigrations(source: Database, target: Database, tableNames: string[]): void {
  if (!tableNames.includes('_sqlx_migrations')) return;
  for (const row of source.prepare('SELECT * FROM _sqlx_migrations').all()) {
    if (!target.prepare('SELECT version FROM _sqlx_migrations WHERE version = ?').get(row.version)) insertRow(target, '_sqlx_migrations', row);
  }
}

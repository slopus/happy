import { createHash } from 'node:crypto';
import { withCodexHistoryCacheLock } from './codexHistoryIndex';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restoreCodexAccountHistory, retainCodexAccountHistory, rememberCodexAccountSession, copyCodexSourceThread, collectRetainedCodexAccountUsage } from './codexAccountHistory';
const dirs: string[] = [];
async function temp() { const h = await mkdtemp(join(tmpdir(), 'codex-history-test-')); dirs.push(h); return h; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(h => rm(h, { recursive: true, force: true }))); });
describe('profile-scoped native history', () => {
  it('records a new session while an unrelated history restore waits on the cache lock', async () => {
    const root = await temp(); const target = await temp();
    const cache = join(root, createHash('sha256').update('profile-a').digest('hex'));
    await mkdir(cache);
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const held = withCodexHistoryCacheLock(cache, () => {
      acquired(); return new Promise<void>(resolve => { release = resolve; });
    });
    await ready;
    const restoring = restoreCodexAccountHistory(root, 'profile-a', target);
    // The restore takes the in-process lock before waiting on SQLite.
    const recording = rememberCodexAccountSession(root, 'new-session', 'profile-b');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let registered = false;
    try {
      registered = await Promise.race([
        recording.then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); }),
      ]);
    } finally {
      clearTimeout(timeout); release(); await Promise.all([held, restoring, recording]);
    }
    expect(registered).toBe(true);
    const audit = join(root, 'session-audit', createHash('sha256').update('new-session').digest('hex') + '.json');
    expect(JSON.parse(await readFile(audit, 'utf8')).profileId).toBe('profile-b');
  });

  it('hands off only the requested thread across profiles through an explicit Paws source-session audit', async () => {
    const cache = await temp(); const source = await temp();
    await mkdir(join(source, 'sessions')); await writeFile(join(source, 'sessions', 'rollout-thread-a.jsonl'), 'requested');
    await writeFile(join(source, 'sessions', 'rollout-thread-other.jsonl'), 'unrelated');
    await retainCodexAccountHistory(cache, 'profile-a', source);
    await rememberCodexAccountSession(cache, 'paws-session-a', 'profile-a');
    const target = await temp();
    await expect(copyCodexSourceThread(cache, 'paws-session-a', 'thread-a', target, 'profile-b')).rejects.toThrow('different account');
    await expect(stat(join(target, 'sessions', 'rollout-thread-a.jsonl'))).rejects.toThrow();
    await copyCodexSourceThread(cache, 'paws-session-a', 'thread-a', target, 'profile-a');
    expect(await readFile(join(target, 'sessions', 'rollout-thread-a.jsonl'), 'utf8')).toBe('requested');
    await expect(stat(join(target, 'sessions', 'rollout-thread-other.jsonl'))).rejects.toThrow();
    await expect(copyCodexSourceThread(cache, 'legacy-unmapped', 'thread-a', target)).rejects.toThrow('unavailable');
    await expect(copyCodexSourceThread(cache, 'paws-session-a', 'missing', target)).rejects.toThrow('unavailable');
  });
  it('restores the same profile after temporary home deletion and excludes auth/config and other profiles', async () => {
    const cache = await temp(); const first = await temp();
    await mkdir(join(first, 'sessions', '2026'), { recursive: true });
    await writeFile(join(first, 'sessions', '2026', 'rollout-thread.jsonl'), 'native-thread');
    await writeFile(join(first, 'auth.json'), 'credential-secret'); await writeFile(join(first, 'config.toml'), 'config-secret');
    await retainCodexAccountHistory(cache, 'profile-a', first);
    await rm(first, { recursive: true, force: true });
    const next = await temp(); await restoreCodexAccountHistory(cache, 'profile-a', next);
    expect(await readFile(join(next, 'sessions', '2026', 'rollout-thread.jsonl'), 'utf8')).toBe('native-thread');
    expect((await stat(join(next, 'sessions'))).mode & 0o777).toBe(0o700);
    await expect(stat(join(next, 'auth.json'))).rejects.toThrow(); await expect(stat(join(next, 'config.toml'))).rejects.toThrow();
    const other = await temp(); await restoreCodexAccountHistory(cache, 'profile-b', other);
    await expect(stat(join(other, 'sessions', '2026', 'rollout-thread.jsonl'))).rejects.toThrow();
  });
  it('does not follow native-history symlinks or copy unrelated files', async () => {
    const cache = await temp(); const first = await temp(); const external = await temp();
    await writeFile(join(external, 'auth.json'), 'secret'); await mkdir(join(first, 'sessions'));
    await symlink(join(external, 'auth.json'), join(first, 'sessions', 'rollout-link.jsonl'));
    await writeFile(join(first, 'sessions', 'auth.json'), 'secret');
    await retainCodexAccountHistory(cache, 'a', first);
    const next = await temp(); await restoreCodexAccountHistory(cache, 'a', next);
    await expect(stat(join(next, 'sessions', 'rollout-link.jsonl'))).rejects.toThrow();
    await expect(stat(join(next, 'sessions', 'auth.json'))).rejects.toThrow();
  });
  it('reports retained usage under only the explicitly audited account profile', async () => {
    const cache = await temp(); const source = await temp();
    const profileId = '00000000-0000-4000-8000-000000000001';
    const timestamp = new Date().toISOString();
    const localParts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(timestamp)).reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value; return result;
    }, {});
    await mkdir(join(source, 'sessions', localParts.year, localParts.month, localParts.day), { recursive: true });
    await writeFile(join(source, 'sessions', localParts.year, localParts.month, localParts.day, 'rollout-attributed.jsonl'), [
      JSON.stringify({ timestamp, type: 'session_meta', payload: { id: 'thread-attributed' } }),
      JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 24 },
        total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 24 },
      } } }),
    ].join('\n'));
    await retainCodexAccountHistory(cache, profileId, source);
    await rememberCodexAccountSession(cache, 'paws-session-attributed', profileId);
    await mkdir(join(cache, 'session-audit'), { recursive: true });
    await writeFile(join(cache, 'session-audit', 'malformed.json'), JSON.stringify({ profileId: 'not-a-profile' }));

    const result = await collectRetainedCodexAccountUsage(cache, { maxDays: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]?.profileId).toBe(profileId);
    expect(result[0]?.usage.today?.totalTokens).toBe(24);
  });
});

let DatabaseSync: any;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { /* Node 20 runs legacy cases only. */ }
function historyDb(home: string) {
  const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS _sqlx_migrations(version INTEGER PRIMARY KEY, checksum BLOB);
    INSERT OR IGNORE INTO _sqlx_migrations VALUES (1, X'1234');
    CREATE TABLE IF NOT EXISTS thread_items(thread_id TEXT, item_id TEXT, item_json TEXT, PRIMARY KEY(thread_id,item_id));
    CREATE TABLE IF NOT EXISTS thread_turns(thread_id TEXT, turn_id TEXT, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE IF NOT EXISTS thread_history_projection_state(thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
    CREATE INDEX IF NOT EXISTS thread_items_lookup ON thread_items(thread_id);
  `);
  return db;
}
async function rollout(home: string, id: string, parent?: string) {
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: {
    id, history_mode: 'paginated', ...(parent ? { history_base: { thread_id: parent, end_ordinal_exclusive: 3, end_byte_offset: 100 } } : {}),
  } }) + '\n');
}
it.skipIf(!DatabaseSync)('preserves WAL history across retention and restores only a fork and its ancestor indexes', async () => {
  const cache = await temp(); const source = await temp(); const target = await temp();
  for (const [id, parent] of [['parent', undefined], ['fork', 'parent'], ['other', undefined]]) await rollout(source, id!, parent);
  const db = historyDb(source);
  try {
    for (const id of ['parent', 'fork', 'other']) {
      db.prepare('INSERT INTO thread_items VALUES (?, ?, ?)').run(id, 'item', JSON.stringify({text: id}));
      db.prepare('INSERT INTO thread_turns VALUES (?, ?)').run(id, 'turn');
      db.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)').run(id, 0, 0);
    }
    await retainCodexAccountHistory(cache, 'a', source);
  } finally { db.close(); }
  await rememberCodexAccountSession(cache, 'session', 'a');
  await copyCodexSourceThread(cache, 'session', 'fork', target, 'a');
  expect(await readFile(join(target, 'sessions', 'rollout-parent.jsonl'), 'utf8')).toContain('parent');
  await expect(stat(join(target, 'sessions', 'rollout-other.jsonl'))).rejects.toThrow();
  const restored = new DatabaseSync(join(target, 'thread_history_1.sqlite'), {readOnly:true});
  try {
    expect(restored.prepare('SELECT thread_id FROM thread_items ORDER BY thread_id').all().map((r: any) => r.thread_id)).toEqual(['fork', 'parent']);
    expect(restored.prepare('SELECT hex(checksum) AS checksum FROM _sqlx_migrations').get().checksum).toBe('1234');
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='thread_items_lookup'").get()).toBeTruthy();
  } finally { restored.close(); }
});
it.skipIf(!DatabaseSync)('does not replace a newer retained projection with an older isolated home', async () => {
  const cache = await temp(); const source = await temp(); const stale = await temp(); const restored = await temp();
  await rollout(source, 'thread');
  const db = historyDb(source);
  try {
    db.prepare('INSERT INTO thread_items VALUES (?, ?, ?)').run('thread', 'item', 'old');
    db.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)').run('thread', 0, 0);
    await retainCodexAccountHistory(cache, 'a', source);
    await restoreCodexAccountHistory(cache, 'a', stale);
    await writeFile(join(source, 'sessions', 'rollout-thread.jsonl'), (await readFile(join(source, 'sessions', 'rollout-thread.jsonl'), 'utf8')) + '{}\n');
    db.prepare('UPDATE thread_items SET item_json=?').run('new');
    db.prepare('UPDATE thread_history_projection_state SET next_rollout_ordinal=1').run();
    await retainCodexAccountHistory(cache, 'a', source);
    const touched = new Date(Date.now() + 10_000);
    await utimes(join(stale, 'sessions', 'rollout-thread.jsonl'), touched, touched);
    await retainCodexAccountHistory(cache, 'a', stale);
    expect(await readFile(join(cache, (await import('node:crypto')).createHash('sha256').update('a').digest('hex'), 'sessions', 'rollout-thread.jsonl'), 'utf8')).toContain('{}\n');
    await restoreCodexAccountHistory(cache, 'a', restored);
    const actual = new DatabaseSync(join(restored, 'thread_history_1.sqlite'), {readOnly:true});
    try { expect(actual.prepare('SELECT item_json FROM thread_items').get().item_json).toBe('new'); }
    finally { actual.close(); }
  } finally { db.close(); }
});
it('rejects missing and cyclic fork history dependencies', async () => {
  const cache = await temp(); const source = await temp();
  await rollout(source, 'fork', 'missing');
  if (DatabaseSync) historyDb(source).close();
  await retainCodexAccountHistory(cache, 'a', source);
  await rememberCodexAccountSession(cache, 'session', 'a');
  await expect(copyCodexSourceThread(cache, 'session', 'fork', await temp(), 'a')).rejects.toThrow('unavailable');
  await rollout(source, 'missing', 'fork');
  await retainCodexAccountHistory(cache, 'a', source);
  await expect(copyCodexSourceThread(cache, 'session', 'fork', await temp(), 'a')).rejects.toThrow('unavailable');
});

it('rejects a scoped rollout whose header identifies another thread', async () => {
  const cache = await temp(); const source = await temp();
  await rollout(source, 'requested');
  await writeFile(join(source, 'sessions', 'rollout-requested.jsonl'), JSON.stringify({type:'session_meta', payload:{id:'unrelated'}}) + '\n');
  await retainCodexAccountHistory(cache, 'a', source);
  await rememberCodexAccountSession(cache, 'session', 'a');
  await expect(copyCodexSourceThread(cache, 'session', 'requested', await temp(), 'a')).rejects.toThrow('unavailable');
});
it('fails closed when a retained paginated thread has lost its history index', async () => {
  const cache = await temp(); const source = await temp();
  await rollout(source, 'thread');
  await retainCodexAccountHistory(cache, 'a', source);
  await rememberCodexAccountSession(cache, 'session', 'a');
  await expect(copyCodexSourceThread(cache, 'session', 'thread', await temp(), 'a')).rejects.toThrow('unavailable');
});

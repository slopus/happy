import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyCodexSourceThread, rememberCodexAccountSession, retainCodexAccountHistory, restoreCodexAccountHistory } from './codexAccountHistory';
import { collectCodexUsageSnapshot } from './codexUsage';
import { CodexAppServerClient } from './codexAppServerClient';
import { CODEX_ACCOUNT_CONFIG } from './codexAccountConfig';
import { withCodexAccountThread } from './codexAccountThread';

const dirs: string[] = [];
const now = new Date('2026-10-05T05:00:00Z');
const folder = join('sessions', '2026', '10', '05');
const file = join(folder, 'rollout-fork.jsonl');
async function temp() { const path = await mkdtemp(join(tmpdir(), 'codex-cross-history-')); dirs.push(path); return path; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const header = (id: string, parent: string) => JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id, forked_from_id: parent } });
const usage = (count: number, total: number, timestamp = now.toISOString()) => JSON.stringify({ timestamp, type: 'event_msg', payload: {
  type: 'token_count', info: { last_token_usage: { input_tokens: count, total_tokens: count }, total_token_usage: { input_tokens: total, total_tokens: total } },
  rate_limits: { secondary: { used_percent: 80, window_minutes: 10080, resets_at: 1792000000 } },
} });
async function snapshot(home: string) { return collectCodexUsageSnapshot({ codexHome: home, now, timeZone: 'UTC' }); }
async function importedFixture() {
  const root = await temp(); const source = await temp(); const target = await temp();
  await mkdir(join(source, folder), { recursive: true });
  const original = header('fork', 'parent') + '\n' + usage(100, 100) + '\n';
  await writeFile(join(source, file), original);
  await retainCodexAccountHistory(root, 'a', source);
  await rememberCodexAccountSession(root, 'session-a', 'a');
  await copyCodexSourceThread(root, 'session-a', 'fork', target, 'a', true);
  return { root, source, target, original };
}

it('does not charge replay or old quota when an imported conversation is forked again in the same account', async () => {
  const { root, target, original } = await importedFixture();
  await retainCodexAccountHistory(root, 'b', target);
  await rememberCodexAccountSession(root, 'session-b', 'b');
  let nativeHome = '';
  await withCodexAccountThread({ sourceSessionId: 'session-b', codexThreadId: 'fork' }, async () => {
    // A native legacy fork rewrites the header but replays the old usage event.
    await writeFile(join(nativeHome, folder, 'rollout-next.jsonl'), header('next', 'fork') + '\n' + usage(100, 100) + '\n');
    return { type: 'success', newCodexThreadId: 'next' };
  }, { historyRoot: root, createClient: env => {
    nativeHome = env.CODEX_HOME!;
    return { connect: vi.fn(), disconnect: vi.fn() } as any;
  } });
  const restored = await temp();
  await restoreCodexAccountHistory(root, 'b', restored);
  expect(await readFile(join(restored, file), 'utf8')).toBe(original);
  expect((await snapshot(restored)).today).toBeNull();
  expect((await snapshot(restored)).latestEvent).toBeNull();
});

it('preserves original usage but excludes a foreign suffix when an ancestor returns from B to A', async () => {
  const { root, target, original } = await importedFixture();
  const foreign = usage(7, 107, '2026-10-05T05:00:01Z') + '\n';
  await writeFile(join(target, file), original + foreign);
  await retainCodexAccountHistory(root, 'b', target);
  await rememberCodexAccountSession(root, 'session-b', 'b');
  const returning = await temp();
  await copyCodexSourceThread(root, 'session-b', 'fork', returning, 'b', true);
  await retainCodexAccountHistory(root, 'a', returning);
  const restored = await temp();
  await restoreCodexAccountHistory(root, 'a', restored);
  expect(await readFile(join(restored, file), 'utf8')).toBe(original + foreign);
  expect((await snapshot(restored)).today?.totalTokens).toBe(100);
  expect((await snapshot(target)).today?.totalTokens).toBe(7);
});

it('marks managed direct forks (including /fork) before allowing new turns', async () => {
  const { target } = await importedFixture();
  const client = new CodexAppServerClient(undefined, { type: 'spawn' }, { CODEX_HOME: target, HAPPY_CODEX_ACCOUNT_PROFILE_ID: 'b' });
  const request = vi.spyOn(client as any, 'request').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === 'config/read') return { config: CODEX_ACCOUNT_CONFIG };
    if (args[0] !== 'thread/fork') throw new Error('Unexpected RPC');
    await writeFile(join(target, folder, 'rollout-direct.jsonl'), header('direct', 'fork') + '\n' + usage(100, 100) + '\n');
    return { thread: { id: 'direct' }, model: 'test-model' };
  });
  try {
    await client.forkThread({ threadId: 'fork' });
    expect(request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ deferGoalContinuation: true }));
    expect((await snapshot(target)).today).toBeNull();
    expect((await snapshot(target)).latestEvent).toBeNull();
  } finally { request.mockRestore(); }
});

it('honors imported ranges through the ripgrep fast path for large histories', async () => {
  const { target, original } = await importedFixture();
  // Push the combined scan above the 16 MiB threshold with unrelated context.
  await writeFile(join(target, folder, 'rollout-large.jsonl'), header('large', 'parent') + '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(17 * 1024 * 1024) } }) + '\n');
  await writeFile(join(target, file), original + usage(9, 109, '2026-10-05T05:00:01Z') + '\n');
  const result = await snapshot(target);
  expect(result.today?.totalTokens).toBe(9);
  expect(result.warnings).toEqual([]);
});

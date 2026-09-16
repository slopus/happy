import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccountLaunch, withCodexAccountLaunch } from './codexAccountLaunch';
import { CodexAccountRequestError } from '@/api/codexAccountTypes';
import { configuration } from '@/configuration';
import { cleanupOrphanedCodexAccountHome } from '@/codex/codexAccountWorker';
import { rememberCodexAccountSession, restoreCodexAccountHistory } from '@/codex/codexAccountHistory';

const auth = { tokens: { id_token: 'id-secret', access_token: 'access-secret', refresh_token: 'refresh-secret', account_id: 'account-secret' } };
const dirs: string[] = [];
async function home() { const h = await mkdtemp(join(tmpdir(), 'codex-launch-test-')); dirs.push(h); return h; }
const originalHappyHome = configuration.happyHomeDir;
beforeEach(async () => { (configuration as { happyHomeDir: string }).happyHomeDir = await home(); });
afterEach(async () => { (configuration as { happyHomeDir: string }).happyHomeDir = originalHappyHome; vi.useRealTimers(); await Promise.all(dirs.splice(0).map(h => rm(h, { recursive: true, force: true }))); });
function api() {
  return {
    redeemCodexSessionGrant: vi.fn(async () => ({ auth, launchId: 'launch-1', profile: { id: 'profile-1', displayName: 'Codex · ABCD', credentialVersion: 3 } })),
    attachCodexSession: vi.fn(async () => ({ success: true as const })),
    updateCodexAccountCredential: vi.fn(async (_id: string, _request: any) => ({ profile: { id: 'profile-1', displayName: 'Codex · ABCD', credentialVersion: 4, status: 'available' as const } })),
    reportCodexAccountQuota: vi.fn(async () => ({ accepted: true })),
    reportCodexAccountStatus: vi.fn(async (_id: string, _request: any) => ({ profile: { id: 'profile-1', displayName: 'Codex · ABCD', credentialVersion: 4, status: 'needs-refresh' as const } })),
  };
}
describe('Codex account launch lifecycle', () => {
  it('preserves orphan-exit rotation and immutable final quota attribution before cleanup', async () => {
    const a = api(); const sourceHome = await home();
    const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome });
    await launch.attach('session-1');
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }));
    await launch.sync();
    const marker = await readFile(join(launch.home, '.paws-account-launch.json'), 'utf8');
    expect((await stat(join(launch.home, '.paws-account-launch.json'))).mode & 0o777).toBe(0o600);
    for (const secret of Object.values(auth.tokens)) expect(marker).not.toContain(secret);
    expect(marker).not.toContain('g'.repeat(43));
    a.updateCodexAccountCredential.mockClear();
    a.updateCodexAccountCredential.mockResolvedValue({ profile: { id: 'profile-1', displayName: 'Codex · ABCD', credentialVersion: 5, status: 'available' } });
    const rotated = { tokens: { ...auth.tokens, access_token: 'rotated-after-daemon', refresh_token: 'latest-refresh' } };
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify(rotated));
    const observed = new Date().toISOString(); const reset = Math.floor(Date.now() / 1000) + 86400;
    await mkdir(join(launch.home, 'sessions'), { recursive: true });
    await writeFile(join(launch.home, 'sessions', 'rollout-thread.jsonl'), JSON.stringify({ timestamp: observed, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2 } }, rate_limits: { secondary: { used_percent: 42, resets_at: reset, window_minutes: 10080 } } } }) + '\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    try {
      await cleanupOrphanedCodexAccountHome(launch.home, a);
      expect(a.updateCodexAccountCredential).toHaveBeenCalledWith('profile-1', { machineId: 'machine-1', launchId: 'launch-1', expectedVersion: 4, auth: rotated });
      expect(a.reportCodexAccountQuota).toHaveBeenCalledWith('profile-1', expect.objectContaining({ sourceSessionId: 'session-1', launchId: 'launch-1', credentialVersion: 3, weeklyUsedPercent: 42 }));
      await expect(stat(launch.home)).rejects.toThrow();
      const restored = await home();
      await restoreCodexAccountHistory(join(configuration.happyHomeDir, 'codex-session-cache'), 'profile-1', restored);
      expect(await readFile(join(restored, 'sessions', 'rollout-thread.jsonl'), 'utf8')).toContain('rate_limits');
      await expect(stat(join(restored, 'auth.json'))).rejects.toThrow();
    } finally { kill.mockRestore(); await launch.finish(); }
  });
  it('waits for an in-flight attachment before deleting its home and never resurrects its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const a = api(); const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome: await home() });
    let resolveAttach!: () => void;
    a.attachCodexSession.mockImplementation(() => new Promise(resolve => { resolveAttach = () => resolve({ success: true }); }));
    const attaching = launch.attach('session-1');
    const attachmentRejected = expect(attaching).rejects.toThrow('exited');
    let finished = false;
    const finishing = launch.finish().then(() => { finished = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      expect((await stat(launch.home)).isDirectory()).toBe(true);
    } finally { resolveAttach(); await Promise.allSettled([attaching, finishing, attachmentRejected]); }
    await attachmentRejected;
    await expect(stat(launch.home)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('continues checking identity after CAS conflict and suppresses quota from a different account', async () => {
    const a = api(); const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome: await home() });
    await launch.attach('session-1');
    a.updateCodexAccountCredential.mockRejectedValue(new CodexAccountRequestError('credential-version-conflict'));
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }));
    await launch.sync(); expect(a.updateCodexAccountCredential).toHaveBeenCalledOnce();
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ tokens: { ...auth.tokens, account_id: 'different-account' } }));
    const observed = new Date().toISOString(); const reset = Math.floor(Date.now() / 1000) + 86400;
    await mkdir(join(launch.home, 'sessions'), { recursive: true });
    await writeFile(join(launch.home, 'sessions', 'usage.jsonl'), JSON.stringify({ timestamp: observed, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }, rate_limits: { secondary: { used_percent: 23, resets_at: reset, window_minutes: 10080 } } } }) + '\n');
    try {
      await launch.sync();
      expect(a.reportCodexAccountQuota).not.toHaveBeenCalled();
      expect(a.updateCodexAccountCredential).toHaveBeenCalledOnce();
    } finally { await launch.finish(); }
  });
  it.each(['regular', 'tmux'] as const)('gates the %s spawn callback with redemption, overrides caller credentials, and attaches the actual session', async mode => {
    const a = api(); const sourceHome = await home(); await writeFile(join(sourceHome, 'auth.json'), 'global');
    let launched: CodexAccountLaunch | undefined;
    const result = await withCodexAccountLaunch({ agent: 'codex', codexSessionGrant: 'g'.repeat(43) }, a, 'machine-1', async launch => {
      launched = launch;
      const env = launch!.environment({ CODEX_HOME: sourceHome, OPENAI_API_KEY: 'global-api-secret', CODEX_API_KEY: 'another-secret' });
      expect(env.CODEX_HOME).not.toBe(sourceHome); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.CODEX_API_KEY).toBeUndefined();
      expect(JSON.parse(await readFile(join(env.CODEX_HOME!, 'auth.json'), 'utf8'))).toEqual(auth);
      expect((await stat(join(env.CODEX_HOME!, 'auth.json'))).mode & 0o777).toBe(0o600);
      return { type: 'success', sessionId: 'actual-session-' + mode };
    }, { sourceHome });
    expect(result.type).toBe('success');
    expect(a.redeemCodexSessionGrant).toHaveBeenCalledWith({ machineId: 'machine-1', grant: 'g'.repeat(43) });
    expect(a.attachCodexSession).toHaveBeenCalledWith('launch-1', { machineId: 'machine-1', sourceSessionId: 'actual-session-' + mode });
    await launched!.finish();
    await expect(stat(launched!.home)).rejects.toThrow();
    expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('global');
  });
  it('uses the machine local Codex login when no account binding grant is supplied', async () => {
    const a = api(); const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'local-session' }));
    const result = await withCodexAccountLaunch({ agent: 'codex' }, a, 'machine-1', spawn);
    expect(result).toEqual({ type: 'success', sessionId: 'local-session' });
    expect(spawn).toHaveBeenCalledWith(undefined);
    expect(a.redeemCodexSessionGrant).not.toHaveBeenCalled();
  });
  it('rejects grantless resume of a session attributed to a managed Codex account', async () => {
    const a = api(); const spawn = vi.fn();
    const historyRoot = join(configuration.happyHomeDir, 'codex-session-cache');
    await rememberCodexAccountSession(historyRoot, 'managed-session', 'profile-1');

    const result = await withCodexAccountLaunch(
      { agent: 'codex' },
      a,
      'machine-1',
      spawn,
      { historyRoot, sourceSessionId: 'managed-session', sourceThreadId: 'managed-thread' },
    );

    expect(result).toEqual({
      type: 'error',
      errorMessage: expect.stringContaining('original Codex account'),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(a.redeemCodexSessionGrant).not.toHaveBeenCalled();
  });
  it('rejects grantless resume from durable account metadata when the local audit is missing', async () => {
    const a = api(); const spawn = vi.fn();

    const result = await withCodexAccountLaunch(
      { agent: 'codex' },
      a,
      'machine-1',
      spawn,
      { sourceSessionId: 'managed-session', sourceThreadId: 'managed-thread', sourceProfileId: 'profile-1' },
    );

    expect(result).toEqual({
      type: 'error',
      errorMessage: expect.stringContaining('original Codex account'),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(a.redeemCodexSessionGrant).not.toHaveBeenCalled();
  });
  it.each(['regular', 'tmux'] as const)('fails closed before %s spawn for malformed and rejected grants', async () => {
    const a = api(); const spawn = vi.fn();
    for (const grant of ['', 'bad']) {
      expect((await withCodexAccountLaunch({ agent: 'codex', codexSessionGrant: grant, token: 'legacy-secret' }, a, 'machine-1', spawn)).type).toBe('error');
    }
    a.redeemCodexSessionGrant.mockRejectedValue(new Error('secret-canary'));
    const result = await withCodexAccountLaunch({ agent: 'codex', codexSessionGrant: 'g'.repeat(43) }, a, 'machine-1', spawn);
    expect(result.type).toBe('error'); expect(JSON.stringify(result)).not.toContain('secret-canary'); expect(spawn).not.toHaveBeenCalled();
  });
  it('keeps Claude token behavior outside Codex redemption', async () => {
    const a = api(); const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'claude-1' }));
    await withCodexAccountLaunch({ agent: 'claude', token: 'claude-secret' }, a, 'machine-1', spawn);
    expect(spawn).toHaveBeenCalledWith(undefined); expect(a.redeemCodexSessionGrant).not.toHaveBeenCalled();
  });
  it('prefers secondary weekly quota from its private JSONL with immutable launch-start version and exact observation time', async () => {
    const a = api(); const sourceHome = await home();
    const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome });
    await launch.attach('session-1');
    const observed = new Date().toISOString(); const reset = Math.floor(Date.now() / 1000) + 86400;
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ ...auth, last_refresh: observed }));
    await mkdir(join(launch.home, 'sessions'), { recursive: true });
    await writeFile(join(launch.home, 'sessions', 'usage.jsonl'), JSON.stringify({ timestamp: observed, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 99999, output_tokens: 5, total_tokens: 100004 } }, rate_limits: { primary: { used_percent: 91, resets_at: reset }, secondary: { used_percent: 23, resets_at: reset, window_minutes: 10080 } } } }) + '\n');
    await launch.sync();
    expect(a.updateCodexAccountCredential).toHaveBeenCalledOnce();
    expect(a.reportCodexAccountQuota).toHaveBeenCalledWith('profile-1', { machineId: 'machine-1', launchId: 'launch-1', sourceSessionId: 'session-1', credentialVersion: 3, weeklyUsedPercent: 23, weeklyResetsAt: new Date(reset * 1000).toISOString(), observedAt: observed });
    await launch.finish();
  });
  it('reports a weekly primary quota when newer Codex clients omit secondary', async () => {
    const a = api(); const sourceHome = await home();
    const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome });
    await launch.attach('session-1');
    const observed = new Date().toISOString(); const reset = Math.floor(Date.now() / 1000) + 86400;
    await mkdir(join(launch.home, 'sessions'), { recursive: true });
    await writeFile(join(launch.home, 'sessions', 'usage.jsonl'), JSON.stringify({ timestamp: observed, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } }, rate_limits: { primary: { used_percent: 20, resets_at: reset, window_minutes: 10080 } } } }) + '\n');
    await launch.sync();
    expect(a.reportCodexAccountQuota).toHaveBeenCalledWith('profile-1', expect.objectContaining({ weeklyUsedPercent: 20 }));
    await launch.finish();
  });
  it('advances only successful CAS versions, never retries a conflicted writer, and reports status at the latest successful version', async () => {
    const a = api(); const launch = await CodexAccountLaunch.prepare(a, 'machine-1', 'g'.repeat(43), { sourceHome: await home() });
    await launch.attach('session-1');
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }));
    await launch.sync(); expect(a.updateCodexAccountCredential.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 3 });
    await launch.reportStatus('needs-refresh'); expect(a.reportCodexAccountStatus.mock.calls.at(-1)?.[1]).toMatchObject({ credentialVersion: 4 });
    await writeFile(join(launch.home, 'auth.json'), JSON.stringify({ ...auth, tokens: { ...auth.tokens, access_token: 'rotated-secret' } }));
    a.updateCodexAccountCredential.mockRejectedValue(new CodexAccountRequestError('credential-version-conflict'));
    await launch.sync(); await launch.sync();
    expect(a.updateCodexAccountCredential).toHaveBeenCalledTimes(2);
    expect(a.updateCodexAccountCredential.mock.calls[1]?.[1]).toMatchObject({ expectedVersion: 4 });
    await launch.finish();
  });
  it('cleans the home on spawn failure and does not attach a failed spawn', async () => {
    const a = api(); let temp: string | undefined;
    const result = await withCodexAccountLaunch({ agent: 'codex', codexSessionGrant: 'g'.repeat(43) }, a, 'machine-1', async launch => {
      temp = launch!.home; throw new Error('secret-canary');
    }, { sourceHome: await home() });
    expect(result.type).toBe('error'); expect(a.attachCodexSession).not.toHaveBeenCalled();
    await expect(stat(temp!)).rejects.toThrow();
  });
});

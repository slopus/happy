import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { configuration } from '@/configuration';
import type { AccountApi } from './codexAccountLaunch';
import { withCodexQuotaProbe } from './codexQuotaProbe';
import { finishCodexQuotaProbe, prepareCodexQuotaProbe, retryPendingCodexProbeCredentials } from './codexQuotaProbeRecovery';

const auth = { tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-old', account_id: 'synthetic-account' } };
const rotated = { tokens: { ...auth.tokens, refresh_token: 'synthetic-new' } };
const originalHome = configuration.happyHomeDir;
let root: string;
let server: Server;
let api: AccountApi;
let failUpload: boolean;
let failQuota: boolean;
let uploads: number;
let version: number;
let saved: typeof auth;
let lastUpload: Record<string, unknown> | undefined;
let sequence: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paws-probe-test-'));
  (configuration as { happyHomeDir: string }).happyHomeDir = root;
  failUpload = false; failQuota = false; uploads = 0; version = 1; saved = auth; lastUpload = undefined; sequence = 0;
  // Exercise real HTTP and files without live accounts or module mocks.
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    let result: unknown;
    if (req.url === '/redeem') result = { auth: saved, launchId: `launch-${++sequence}`, profile: { id: 'profile', credentialVersion: version } };
    else if (req.url === '/credential') {
      uploads++; lastUpload = body;
      if (failUpload) { res.statusCode = 503; result = { error: 'synthetic-private-error' }; }
      else { saved = body.auth; version++; result = { profile: { id: 'profile', credentialVersion: version } }; }
    } else if (req.url === '/quota') {
      res.statusCode = failQuota ? 503 : 200; result = { accepted: !failQuota };
    } else result = {};
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const request = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error('synthetic-private-error');
    return await response.json() as T;
  };
  api = {
    redeemCodexSessionGrant: body => request('/redeem', body),
    attachCodexSession: (_id, body) => request('/attach', body),
    updateCodexAccountCredential: (_id, body) => request('/credential', body),
    reportCodexAccountQuota: (_id, body) => request('/quota', body),
    reportCodexAccountQuotaProbe: (_id, body) => request('/quota', body),
    reportCodexAccountStatus: (_id, body) => request('/status', body),
  };
});
afterEach(async () => {
  (configuration as { happyHomeDir: string }).happyHomeDir = originalHome;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function writeProbeOutput(env: NodeJS.ProcessEnv): Promise<void> {
  const home = env.CODEX_HOME!;
  await writeFile(join(home, 'auth.json'), JSON.stringify(rotated));
  await mkdir(join(home, 'sessions'), { recursive: true });
  await writeFile(join(home, 'sessions', 'rollout-probe.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: 1 } },
    rate_limits: { primary: { used_percent: 12, resets_at: Math.floor(Date.now() / 1000) + 3600, window_minutes: 10080 } },
  } }) + '\n');
}
const pendingHomes = async (): Promise<string[]> => (await readdir(join(root, 'codex-quota-probes'))).map(name => join(root, 'codex-quota-probes', name));

describe('quota probe credential preservation', () => {
  it('uploads rotated credentials and removes a successful probe', async () => {
    const result = await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), writeProbeOutput);
    expect(result).toEqual({ type: 'success', accepted: true });
    expect(saved).toEqual(rotated); expect(uploads).toBe(1); expect(await pendingHomes()).toEqual([]);
  });

  it('saves rotation even when the model request fails afterwards', async () => {
    const result = await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), async env => {
      await writeProbeOutput(env); throw new Error('synthetic-private-error');
    });
    expect(result.type).toBe('error'); expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
    expect(saved).toEqual(rotated); expect(uploads).toBe(1); expect(await pendingHomes()).toEqual([]);
  });

  it('cleans up a failed request when the login did not change', async () => {
    await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), async () => { throw new Error('model failed'); });
    expect(uploads).toBe(0); expect(await pendingHomes()).toEqual([]);
  });

  it('keeps the only new credential private through an outage and recovers using its original grant', async () => {
    failUpload = true;
    const result = await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), writeProbeOutput);
    expect(result.type).toBe('error'); expect(JSON.stringify(result)).toContain('preserved');
    const [home] = await pendingHomes();
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(rotated);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
    await retryPendingCodexProbeCredentials(api, 'machine');
    expect(await stat(home)).toBeDefined();
    failUpload = false; const before = uploads;
    await Promise.all([retryPendingCodexProbeCredentials(api, 'machine'), retryPendingCodexProbeCredentials(api, 'machine')]);
    expect(uploads - before).toBe(1); expect(sequence).toBe(1); expect(saved).toEqual(rotated);
    expect(lastUpload).toMatchObject({ launchId: 'launch-1', expectedVersion: 1, machineId: 'machine' });
    expect(await pendingHomes()).toEqual([]);
  });

  it('still preserves rotation when quota parsing or publishing fails', async () => {
    failQuota = true;
    const result = await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), writeProbeOutput);
    expect(result.type).toBe('error'); expect(saved).toEqual(rotated); expect(await pendingHomes()).toEqual([]);
  });

  it('does not upload changed identities or destroy their evidence', async () => {
    const result = await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), async env => {
      await writeFile(join(env.CODEX_HOME!, 'auth.json'), JSON.stringify({ tokens: { ...rotated.tokens, account_id: 'other-account' } }));
      throw new Error('failure');
    });
    expect(result.type).toBe('error'); expect(uploads).toBe(0); expect(await pendingHomes()).toHaveLength(1);
    await retryPendingCodexProbeCredentials(api, 'machine'); expect(uploads).toBe(0); expect(await pendingHomes()).toHaveLength(1);
  });

  it('does not clean up unreadable credentials', async () => {
    await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), async env => {
      await writeFile(join(env.CODEX_HOME!, 'auth.json'), '{'); throw new Error('failure');
    });
    expect(await pendingHomes()).toHaveLength(1); expect(uploads).toBe(0);
  });

  it('skips a running producer and entries belonging to another machine', async () => {
    await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), async env => {
      await writeProbeOutput(env); await retryPendingCodexProbeCredentials(api, 'machine');
      expect(uploads).toBe(0); expect(await stat(env.CODEX_HOME!)).toBeDefined();
    });
    saved = auth; failUpload = true; await withCodexQuotaProbe(api, 'machine', 'g'.repeat(43), writeProbeOutput);
    failUpload = false; const before = uploads;
    await retryPendingCodexProbeCredentials(api, 'another-machine'); expect(uploads).toBe(before); expect(await pendingHomes()).toHaveLength(1);
  });

  it('recovers an orphaned probe after daemon death without needing a pending marker', async () => {
    const launch = await prepareCodexQuotaProbe(api, 'machine', 'g'.repeat(43));
    const orphan = join(root, 'codex-quota-probes', 'probe-orphan');
    await cp(launch.home, orphan, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']); await once(child, 'exit');
    const marker = join(orphan, '.paws-account-launch.json');
    const state = JSON.parse(await readFile(marker, 'utf8')); state.daemonPid = child.pid;
    await writeFile(marker, JSON.stringify(state)); await writeFile(join(orphan, 'auth.json'), JSON.stringify(rotated));
    await retryPendingCodexProbeCredentials(api, 'machine');
    expect(saved).toEqual(rotated); await expect(stat(orphan)).rejects.toThrow();
    await finishCodexQuotaProbe(launch);
  });

  it('does not follow a symlink entry outside the recovery directory', async () => {
    const launch = await prepareCodexQuotaProbe(api, 'machine', 'g'.repeat(43));
    await symlink(launch.home, join(root, 'codex-quota-probes', 'probe-link'));
    await retryPendingCodexProbeCredentials(api, 'machine'); expect(uploads).toBe(0);
    expect(await stat(launch.home)).toBeDefined(); await finishCodexQuotaProbe(launch);
  });
});

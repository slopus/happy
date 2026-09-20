import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { CodexAccountRequestError } from '@/api/codexAccountTypes';
import { CodexAccountLaunch, type AccountApi } from './codexAccountLaunch';
import { retryPendingCodexSessionCredentials } from './codexSessionCredentialRecovery';

const oldAuth = { tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-old', account_id: 'synthetic-account' } };
const rotated = { tokens: { ...oldAuth.tokens, refresh_token: 'synthetic-new' } };
const originalHome = configuration.happyHomeDir;
let root: string, sourceHome: string, server: Server, api: AccountApi;
let saved: typeof oldAuth, version: number, outage: boolean, conflict: boolean, sequence: number, attempts: number;
let lastUpload: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paws-session-recovery-test-'));
  sourceHome = join(root, 'source'); await mkdir(sourceHome);
  (configuration as { happyHomeDir: string }).happyHomeDir = root;
  saved = oldAuth; version = 1; outage = false; conflict = false; sequence = 0; attempts = 0;
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); let result: unknown = {};
    if (req.url === '/redeem') result = { auth: saved, launchId: `launch-${++sequence}`, profile: { id: 'profile', credentialVersion: version } };
    if (req.url === '/credential') {
      attempts++; lastUpload = input;
      if (outage) { res.statusCode = 503; result = { error: 'outage' }; }
      else if (conflict || input.expectedVersion !== version) { res.statusCode = 409; result = { error: 'credential-version-conflict' }; }
      else { saved = input.auth; version++; result = { profile: { id: 'profile', credentialVersion: version } }; }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP fixture');
  const request = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const data = await response.json();
    if (response.status === 409) throw new CodexAccountRequestError('credential-version-conflict');
    if (!response.ok) throw new Error('unavailable');
    return data as T;
  };
  api = { redeemCodexSessionGrant: input => request('/redeem', input), attachCodexSession: (_id, input) => request('/attach', input),
    updateCodexAccountCredential: (_id, input) => request('/credential', input), reportCodexAccountQuota: (_id, input) => request('/quota', input), reportCodexAccountStatus: (_id, input) => request('/status', input) };
});
afterEach(async () => {
  (configuration as { happyHomeDir: string }).happyHomeDir = originalHome;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
async function launch() {
  const result = await CodexAccountLaunch.prepare(api, 'machine', 'g'.repeat(43), { sourceHome, skipHistory: true });
  await result.attach('session-' + sequence);
  return result;
}

describe('ordinary Codex session credential recovery', () => {
  it('retries the final rotation over HTTP using the original attribution and lets the next session rotate again', async () => {
    const first = await launch();
    await writeFile(join(first.home, 'auth.json'), JSON.stringify(rotated));
    outage = true; await first.finish();
    expect(JSON.parse(await readFile(join(first.home, 'auth.json'), 'utf8'))).toEqual(rotated);
    await retryPendingCodexSessionCredentials(api, 'machine');
    expect(saved).toEqual(oldAuth);
    outage = false;
    const before = attempts;
    await Promise.all([retryPendingCodexSessionCredentials(api, 'machine'), retryPendingCodexSessionCredentials(api, 'machine')]);
    expect(attempts - before).toBe(1);
    expect(lastUpload).toMatchObject({ machineId: 'machine', launchId: 'launch-1', expectedVersion: 1, auth: rotated });
    expect(saved).toEqual(rotated); expect(version).toBe(2);
    await expect(stat(first.home)).rejects.toThrow();
    const next = await launch();
    expect(JSON.parse(await readFile(join(next.home, 'auth.json'), 'utf8'))).toEqual(rotated);
    await writeFile(join(next.home, 'auth.json'), JSON.stringify({ tokens: { ...rotated.tokens, refresh_token: 'synthetic-next' } }));
    await next.finish();
    expect(saved.tokens.refresh_token).toBe('synthetic-next'); expect(version).toBe(3);
  });

  it('skips active homes and pending homes owned by another machine', async () => {
    const first = await launch();
    await writeFile(join(first.home, 'auth.json'), JSON.stringify(rotated));
    await retryPendingCodexSessionCredentials(api, 'machine'); expect(attempts).toBe(0);
    outage = true; await first.finish(); const before = attempts; outage = false;
    await retryPendingCodexSessionCredentials(api, 'other-machine');
    expect(attempts).toBe(before); expect(saved).toEqual(oldAuth);
    await retryPendingCodexSessionCredentials(api, 'machine'); expect(saved).toEqual(rotated);
  });

  it('keeps conflicted credentials without repeatedly uploading or overwriting the account store', async () => {
    const first = await launch();
    await writeFile(join(first.home, 'auth.json'), JSON.stringify(rotated));
    conflict = true; await first.finish(); const before = attempts;
    await retryPendingCodexSessionCredentials(api, 'machine'); await retryPendingCodexSessionCredentials(api, 'machine');
    expect(attempts).toBe(before); expect(saved).toEqual(oldAuth);
    expect(JSON.parse(await readFile(join(first.home, 'auth.json'), 'utf8'))).toEqual(rotated);
  });

  it('does not follow a recovery entry symlink outside the durable directory', async () => {
    const first = await launch(); outage = true;
    await writeFile(join(first.home, 'auth.json'), JSON.stringify(rotated)); await first.finish();
    const outside = join(root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'auth.json'), 'outside-canary');
    await symlink(outside, join(root, 'codex-session-homes', 'happy-codex-home-link'));
    outage = false; await retryPendingCodexSessionCredentials(api, 'machine');
    expect(await readFile(join(outside, 'auth.json'), 'utf8')).toBe('outside-canary');
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSessionCredentialRecovery } from './codexSessionCredentialRecovery';

const auth = { tokens: { id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: 'original-account' } };
const dirs: string[] = [];
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'paws-auth-recovery-')); dirs.push(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  await writeFile(join(home, '.paws-account-launch.json'), JSON.stringify({
    schemaVersion: 1, daemonPid: 123, machineId: 'machine', profileId: 'profile', launchId: 'launch',
    credentialVersion: 1, currentVersion: 1,
    authFingerprint: 'a'.repeat(64),
    accountFingerprint: createHash('sha256').update('launch\0original-account').digest('hex'),
    historyRoot: home, sourceSessionId: 'session', startedAt: Date.now(), writeDisabled: false, identityInvalid: false,
  }));
  return home;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it('waits for the original account upload, installs only a newer credential, and keeps the private file mode', async () => {
  const home = await makeHome();
  const rotated = { tokens: { ...auth.tokens, refresh_token: 'new-refresh' } };
  const readCodexSessionCredential = vi.fn()
    .mockResolvedValueOnce({ profileId: 'profile', status: 'available', credentialVersion: 1 })
    .mockResolvedValueOnce({ profileId: 'profile', status: 'needs-refresh', credentialVersion: 1 })
    .mockResolvedValueOnce({ profileId: 'profile', status: 'available', credentialVersion: 2, auth: rotated });
  const reportCodexAccountStatus = vi.fn().mockResolvedValue({});
  const onWaiting = vi.fn();
  const recovery = new CodexSessionCredentialRecovery({ readCodexSessionCredential, reportCodexAccountStatus } as never, home, 'machine', 'session');
  expect(await recovery.waitForNewCredential({ signal: new AbortController().signal, onWaiting, pollIntervalMs: 1 })).toBe(true);
  expect(reportCodexAccountStatus).toHaveBeenCalledWith('profile', expect.objectContaining({ credentialVersion: 1, status: 'needs-refresh' }));
  expect(onWaiting).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(rotated);
  expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(home, '.paws-auth-adoption.json'), 'utf8'))).toMatchObject({
    launchId: 'launch', profileId: 'profile', credentialVersion: 2,
  });
  expect((await stat(join(home, '.paws-auth-adoption.json'))).mode & 0o777).toBe(0o600);
});

it('refuses a credential from a different provider account', async () => {
  const home = await makeHome();
  const readCodexSessionCredential = vi.fn().mockResolvedValue({
    profileId: 'profile', status: 'available', credentialVersion: 2,
    auth: { tokens: { ...auth.tokens, account_id: 'different-account' } },
  });
  const recovery = new CodexSessionCredentialRecovery({ readCodexSessionCredential, reportCodexAccountStatus: vi.fn() } as never, home, 'machine', 'session');
  await expect(recovery.waitForNewCredential({ signal: new AbortController().signal, onWaiting: vi.fn(), pollIntervalMs: 1 }))
    .rejects.toThrow('identity changed');
  expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(auth);
});

it('can cancel the pending turn without replacing its credential', async () => {
  const home = await makeHome();
  const controller = new AbortController();
  const onWaiting = vi.fn(() => controller.abort());
  const recovery = new CodexSessionCredentialRecovery({
    readCodexSessionCredential: vi.fn().mockResolvedValue({ profileId: 'profile', status: 'needs-refresh', credentialVersion: 1 }),
    reportCodexAccountStatus: vi.fn(),
  } as never, home, 'machine', 'session');
  expect(await recovery.waitForNewCredential({ signal: controller.signal, onWaiting, pollIntervalMs: 1 })).toBe(false);
  expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(auth);
});

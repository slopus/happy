import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupOrphanedCodexAccountHome, codexAccountSessionMetadata, startCodexAccountWorkerObserver } from './codexAccountWorker';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';
import { CodexAccountRequestError } from '@/api/codexAccountTypes';
import * as checkpoint from './codexAccountLaunchState';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(dirs.splice(0).map(h => rm(h, { recursive: true, force: true }))); });

async function checkpointFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-worker-test-')); dirs.push(root);
  const auth = { tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'refresh-v1', account_id: 'synthetic-account' } };
  let version = 1;
  let savedAuth = auth;
  const acceptedVersions: number[] = [];
  const api: AccountApi = {
    redeemCodexSessionGrant: async () => ({ auth, launchId: 'launch-a', profile: { id: 'profile-a', displayName: 'Work', credentialVersion: 1 } }),
    attachCodexSession: async () => ({ success: true }),
    updateCodexAccountCredential: async (_profileId, input) => {
      if (input.expectedVersion !== version) throw new CodexAccountRequestError('credential-version-conflict');
      acceptedVersions.push(input.expectedVersion);
      savedAuth = input.auth; ++version;
      return { profile: { id: 'profile-a', displayName: 'Work', status: 'available', credentialVersion: version } };
    },
    reportCodexAccountQuota: async () => ({ accepted: true }),
    reportCodexAccountStatus: async () => ({ profile: { id: 'profile-a', displayName: 'Work', status: 'needs-refresh', credentialVersion: version } }),
  };
  const launch = await CodexAccountLaunch.prepare(api, 'machine-a', 'g'.repeat(43), { sourceHome: root, historyRoot: join(root, 'cache') });
  dirs.push(launch.home);
  await launch.attach('session-a');
  return { api, auth, launch, acceptedVersions, getVersion: () => version, getSavedAuth: () => savedAuth };
}

function pauseFirstCheckpointRead() {
  const read = checkpoint.readCodexAccountLaunchState;
  let captured!: () => void;
  let release!: () => void;
  const capturedPromise = new Promise<void>(resolve => { captured = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(checkpoint, 'readCodexAccountLaunchState').mockImplementationOnce(async home => {
    const snapshot = await read(home);
    captured(); await released;
    return snapshot;
  });
  return { captured: capturedPromise, release };
}

describe('Codex worker account lifecycle', () => {
  it('rereads the final checkpoint after daemon death before cadence CAS and later exit flush', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const f = await checkpointFixture();
    // Drive daemon writes explicitly and retain only the surviving worker timer.
    vi.clearAllTimers();
    const paused = pauseFirstCheckpointRead();
    const worker = startCodexAccountWorkerObserver(f.api, f.launch.home);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('daemon gone'), { code: 'ESRCH' }); });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await paused.captured; // worker has v1, before its liveness check
      await writeFile(join(f.launch.home, 'auth.json'), JSON.stringify({ tokens: { ...f.auth.tokens, refresh_token: 'refresh-v2' } }));
      await f.launch.sync(); // daemon performs final CAS, checkpoints v2, then exits
      expect(f.getVersion()).toBe(2);
      await writeFile(join(f.launch.home, 'auth.json'), JSON.stringify({ tokens: { ...f.auth.tokens, refresh_token: 'refresh-v3' } }));
      paused.release(); // worker receives its old v1 snapshot, then observes ESRCH
      await vi.waitFor(() => expect(f.getVersion()).toBe(3));
      expect(f.getSavedAuth().tokens.refresh_token).toBe('refresh-v3');
      await writeFile(join(f.launch.home, 'auth.json'), JSON.stringify({ tokens: { ...f.auth.tokens, refresh_token: 'refresh-v4' } }));
      await worker.finish();
      expect(f.getSavedAuth().tokens.refresh_token).toBe('refresh-v4');
      expect(f.acceptedVersions).toEqual([1, 2, 3]);
      await expect(stat(f.launch.home)).rejects.toThrow();
    } finally { paused.release(); await worker.finish(); await f.launch.finish(); }
  });

  it.each([
    ['daemonPid', 987654], ['launchId', 'different-launch'], ['profileId', 'different-profile'],
    ['machineId', 'different-machine'], ['sourceSessionId', 'different-session'],
  ])('does not adopt or delete a checkpoint whose %s changed during the death check', async (field, replacement) => {
    const f = await checkpointFixture();
    const state = await checkpoint.readCodexAccountLaunchState(f.launch.home);
    const paused = pauseFirstCheckpointRead();
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('daemon gone'), { code: 'ESRCH' }); });
    const cleanup = cleanupOrphanedCodexAccountHome(f.launch.home, f.api);
    try {
      await paused.captured;
      await checkpoint.writeCodexAccountLaunchState(f.launch.home, { ...state, [field]: replacement });
      await writeFile(join(f.launch.home, 'auth.json'), JSON.stringify({ tokens: { ...f.auth.tokens, refresh_token: 'different-owner-refresh' } }));
      paused.release(); await cleanup;
      expect(f.getVersion()).toBe(1);
      expect((await stat(f.launch.home)).isDirectory()).toBe(true);
    } finally { paused.release(); await cleanup; await f.launch.finish(); }
  });
  it('retains orphaned credentials when no API is available to acknowledge their upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-worker-test-')); dirs.push(root);
    const home = await mkdtemp(join(tmpdir(), 'happy-codex-home-')); dirs.push(home);
    await writeFile(join(home, '.paws-account-launch.json'), JSON.stringify({ daemonPid: 123456, profileId: 'profile-a', historyRoot: join(root, 'cache') }));
    await writeFile(join(home, 'auth.json'), 'credential'); await mkdir(join(home, 'sessions'));
    await writeFile(join(home, 'sessions', 'rollout-thread.jsonl'), 'thread');
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    await cleanupOrphanedCodexAccountHome(home); expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('credential');
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    await cleanupOrphanedCodexAccountHome(home); expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('credential');
  });
  it('only exposes non-secret profile attribution from valid launch environment', () => {
    expect(codexAccountSessionMetadata({ HAPPY_CODEX_ACCOUNT_PROFILE_ID: '00000000-0000-4000-8000-000000000001', HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION: '3', SECRET: 'secret' })).toEqual({ codexAccountProfileId: '00000000-0000-4000-8000-000000000001', codexAccountCredentialVersion: 3 });
    expect(codexAccountSessionMetadata({ HAPPY_CODEX_ACCOUNT_PROFILE_ID: 'bad', HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION: 'NaN' })).toEqual({});
  });
});

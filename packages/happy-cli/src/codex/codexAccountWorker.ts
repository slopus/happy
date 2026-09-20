import { readFile, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { retainCodexAccountHistory } from './codexAccountHistory';
import { readCodexAccountLaunchState } from './codexAccountLaunchState';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';

async function recoverOrphanedObserver(home: string | undefined, api: AccountApi): Promise<CodexAccountLaunch | undefined> {
  if (!home || !basename(home).startsWith('happy-codex-home-')) return;
  const state = await readCodexAccountLaunchState(home);
  // Replacement daemons never own this home. Only the original daemon can be
  // writing its checkpoint; ESRCH guarantees its final CAS cannot race ours.
  try { process.kill(state.daemonPid, 0); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
  // The daemon may have completed its last CAS after our first read. Only the
  // checkpoint read after confirmed death carries its final successful version.
  const finalState = await readCodexAccountLaunchState(home);
  const attribution = ['daemonPid', 'launchId', 'machineId', 'profileId', 'sourceSessionId',
    'credentialVersion', 'accountFingerprint', 'startedAt', 'historyRoot'] as const;
  if (attribution.some(key => finalState[key] !== state[key]) || finalState.currentVersion < state.currentVersion) return;
  return CodexAccountLaunch.recover(api, home, finalState);
}

/** Survives daemon replacement because the observer runs in the session worker. */
export function startCodexAccountWorkerObserver(api: AccountApi, home = process.env.CODEX_HOME): { finish(): Promise<void> } {
  let pending = Promise.resolve();
  let finishing: Promise<void> | undefined;
  const observe = async () => {
    const observer = await recoverOrphanedObserver(home, api);
    await observer?.sync();
  };
  const timer = home && basename(home).startsWith('happy-codex-home-') ? setInterval(() => {
    pending = pending.then(observe).catch(() => undefined);
  }, 60_000) : undefined;
  timer?.unref();
  return { finish: () => {
    clearInterval(timer);
    return finishing ??= pending.then(() => cleanupOrphanedCodexAccountHome(home, api)).catch(() => undefined);
  } };
}

export async function cleanupOrphanedCodexAccountHome(home = process.env.CODEX_HOME, api?: AccountApi): Promise<void> {
  if (api) {
    try { await (await recoverOrphanedObserver(home, api))?.finish(); } catch { /* Leave unreadable checkpoints untouched. */ }
    return;
  }
  if (!home || !basename(home).startsWith('happy-codex-home-')) return;
  try {
    const markerPath = join(home, '.paws-account-launch.json');
    if (!(await lstat(markerPath)).isFile()) return;
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!Number.isSafeInteger(marker.daemonPid) || marker.daemonPid <= 0 || typeof marker.profileId !== 'string' || typeof marker.historyRoot !== 'string') return;
    try { process.kill(marker.daemonPid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    await retainCodexAccountHistory(marker.historyRoot, marker.profileId, home);
    // Without an API/checkpoint reconciliation we cannot know whether auth was uploaded.
    // Leave the login in place for its account-aware owner to recover.
  } catch { /* Best effort when another cleanup already owns this home. */ }
}

export function codexAccountSessionMetadata(env = process.env): { codexAccountProfileId?: string; codexAccountCredentialVersion?: number } {
  const profileId = env.HAPPY_CODEX_ACCOUNT_PROFILE_ID;
  const version = Number(env.HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION);
  if (!profileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId) || !Number.isInteger(version) || version < 1) return {};
  return { codexAccountProfileId: profileId, codexAccountCredentialVersion: version };
}

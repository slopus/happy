/** Preserve probe credentials until acknowledged, including across daemon restarts. */
import { mkdtempSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { readCodexAccountLaunchState } from '@/codex/codexAccountLaunchState';
import { logger } from '@/ui/logger';
import { CodexAccountLaunch, type AccountApi } from './codexAccountLaunch';

const pendingMarker = '.paws-probe-pending';
const activeHomes = new Set<string>();
const drains = new Map<string, Promise<void>>();
const recoveryRoot = (): string => join(configuration.happyHomeDir, 'codex-quota-probes');

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function prepareCodexQuotaProbe(api: AccountApi, machineId: string, grant: string): Promise<CodexAccountLaunch> {
  const root = recoveryRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error('Invalid Codex probe recovery directory');
  await chmod(root, 0o700);
  let home: string | undefined;
  try {
    return await CodexAccountLaunch.prepare(api, machineId, grant, {
      skipHistory: true,
      // Start on durable storage: a crash must not leave the only rotated token in OS temp.
      createTempDir: () => {
        home = mkdtempSync(join(root, 'probe-'));
        activeHomes.add(home);
        return home;
      },
    });
  } catch (error) {
    if (home) activeHomes.delete(home);
    throw error;
  }
}

/** Call only after the producer has disconnected. Never clean up an unacknowledged login. */
export async function finishCodexQuotaProbe(launch: CodexAccountLaunch): Promise<boolean> {
  try {
    await launch.syncProbeCredential();
    await launch.finish();
    return true;
  } catch {
    // Neither provider errors nor auth contents belong in diagnostics.
    await writeFile(join(launch.home, pendingMarker), '', { mode: 0o600, flag: 'wx' }).catch(() => undefined);
    logger.debug('[CODEX QUOTA] Credential recovery pending', { profileId: launch.profileId, launchId: launch.launchId });
    return false;
  } finally {
    activeHomes.delete(launch.home);
  }
}

/** Serialized per recovery root; an active probe or another live daemon retains ownership. */
export function retryPendingCodexProbeCredentials(api: AccountApi, machineId: string): Promise<void> {
  const root = recoveryRoot();
  const existing = drains.get(root);
  if (existing) return existing;
  const pending = (async () => {
    if (!await lstat(root).then(s => s.isDirectory()).catch(() => false)) return;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('probe-')) continue;
      const home = join(root, entry.name);
      if (activeHomes.has(home)) continue;
      try {
        const state = await readCodexAccountLaunchState(home);
        if (state.machineId !== machineId || state.sourceSessionId) continue;
        const ownerAlive = isAlive(state.daemonPid);
        if (ownerAlive && state.daemonPid !== process.pid) continue;
        const ready = await lstat(join(home, pendingMarker)).then(s => s.isFile()).catch(() => false);
        if (ownerAlive && !ready) continue;
        // Recovery always uses the original launch/version, never a new grant or binding.
        const launch = CodexAccountLaunch.recover(api, home, state);
        await finishCodexQuotaProbe(launch);
      } catch {
        // Unreadable state/credentials stay on disk for recovery, never discarded.
        logger.debug('[CODEX QUOTA] Preserved unreadable credential recovery entry');
      }
    }
  })().finally(() => { drains.delete(root); });
  drains.set(root, pending);
  return pending;
}

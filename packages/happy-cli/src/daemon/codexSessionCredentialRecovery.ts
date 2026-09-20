import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEX_SESSION_FINISHED_MARKER, codexSessionHomesRoot } from '@/codex/codexSessionHome';
import { readCodexAccountLaunchState } from '@/codex/codexAccountLaunchState';
import { CodexAccountLaunch, type AccountApi } from './codexAccountLaunch';

const drains = new Map<string, Promise<void>>();

/** Only finalized homes are eligible; a live session remains its worker's responsibility. */
export function retryPendingCodexSessionCredentials(api: AccountApi, machineId: string): Promise<void> {
  const root = codexSessionHomesRoot();
  const existing = drains.get(root);
  if (existing) return existing;
  const pending = (async () => {
    if (!await lstat(root).then(s => s.isDirectory()).catch(() => false)) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('happy-codex-home-')) continue;
      const home = join(root, entry.name);
      try {
        if (!await lstat(join(home, CODEX_SESSION_FINISHED_MARKER)).then(s => s.isFile()).catch(() => false)) continue;
        const state = await readCodexAccountLaunchState(home);
        if (state.machineId !== machineId || state.writeDisabled || state.identityInvalid) continue;
        await CodexAccountLaunch.recover(api, home, state).finish();
      } catch { /* Preserve unreadable/conflicted state, never log credentials or discard it. */ }
    }
  })().catch(() => undefined).finally(() => { drains.delete(root); });
  drains.set(root, pending);
  return pending;
}

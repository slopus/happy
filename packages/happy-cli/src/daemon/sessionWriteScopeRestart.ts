import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { containsPath, type WriteRoot } from './sessionWriteScopePaths';

export function scopeSandboxEnvironment(config: SandboxConfig, roots: readonly WriteRoot[], projectRoot: string): Record<string, string> {
  if (!config.enabled) throw new Error('PROTECTED_SESSION_REQUIRED');
  for (const entry of roots) {
    for (const denied of [...config.denyReadPaths, ...config.denyWritePaths]) {
      const expanded = denied.replace(/^~(?=\/|$)/, homedir());
      const path = isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
      if (containsPath(path, entry.root) || containsPath(entry.root, path)) throw new Error('POLICY_DENIES_WRITE_ROOT');
    }
  }
  const floor = [...new Set(roots.flatMap(entry => entry.floor))];
  // Write protection includes credential/config/runtime stores. Existing read denies remain unchanged.
  // Provider authentication may legitimately read its own config, so this grant adds no read permission.
  const applied = { ...config, extraWritePaths: [...new Set([...config.extraWritePaths, ...roots.map(entry => entry.root)])],
    denyWritePaths: [...new Set([...config.denyWritePaths, ...floor])] };
  return { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(applied), HAPPY_WRITE_SCOPE_BASE_CONFIG: JSON.stringify(config) };
}

async function stopOwnedChild(child: ChildProcess, signal = true): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    child.once('exit', done);
    timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('ROOT_EXIT_UNCONFIRMED')); }, 10000);
    try { if (signal && !child.kill('SIGTERM')) { clearTimeout(timer); child.removeListener('exit', done); reject(new Error('ROOT_STOP_FAILED')); } }
    catch (error) { clearTimeout(timer); child.removeListener('exit', done); reject(error); }
  });
}

/** Root exit is sufficient for replacement admission, never for full permission revocation. */
export async function replaceSessionWriteScope(input: {
  busy: boolean; child: ChildProcess | null; preserve: () => boolean;
  resume: (env: Record<string, string>) => Promise<{ type: string }>;
  waitForProfile: () => Promise<boolean>; environment: Record<string, string>;
  drain?: () => Promise<boolean>;
}): Promise<{ profileApplied: boolean; cleanup: 'unresolved' }> {
  if (input.busy) throw new Error('SESSION_SCOPE_BUSY');
  if (!input.preserve()) throw new Error('SESSION_PRESERVATION_FAILED');
  try {
    if (input.drain && !await input.drain()) return { profileApplied: false, cleanup: 'unresolved' };
    if (input.child) await stopOwnedChild(input.child, !input.drain);
    const resumed = await input.resume(input.environment);
    return { profileApplied: resumed.type === 'success' && await input.waitForProfile(), cleanup: 'unresolved' };
  } catch { return { profileApplied: false, cleanup: 'unresolved' }; }
}

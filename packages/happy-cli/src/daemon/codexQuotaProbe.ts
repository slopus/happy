import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AccountApi } from './codexAccountLaunch';
import { CodexAccountLaunch } from './codexAccountLaunch';

const PROBE_TIMEOUT_MS = 45_000;
const TERMINATION_GRACE_MS = 5_000;
const PROBE_PROMPT = 'Reply with exactly: ok';

function applyCodexNetworkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxyUrl = env.HAPPY_CODEX_PROXY_URL || env.CODEX_PROXY_URL;
  return proxyUrl ? { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl } : env;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Already stopped. */ }
}

function runProbeProcess(environment: NodeJS.ProcessEnv, onStart: (pid: number) => void, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let finalTimer: NodeJS.Timeout | undefined;
    try {
      // `codex exec` is the supported local Codex entry point. Its first model
      // event carries the same rate-limit snapshot used by ordinary sessions.
      child = spawn('codex', ['exec', '--skip-git-repo-check', PROBE_PROMPT], {
        cwd: tmpdir(), env: environment, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: process.platform !== 'win32',
      });
    } catch { reject(new Error('Unable to start the Codex quota probe')); return; }
    if (child.pid) onStart(child.pid);
    const clear = () => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); if (finalTimer) clearTimeout(finalTimer); };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        terminate(child, 'SIGKILL');
        finalTimer = setTimeout(() => { reject(new Error('Codex quota probe timed out')); }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);
    child.once('error', () => { clear(); reject(new Error('Unable to start the Codex quota probe')); });
    child.once('exit', (code) => {
      clear();
      if (timedOut) reject(new Error('Codex quota probe timed out'));
      else if (code === 0) resolve();
      else reject(new Error('Codex quota probe did not complete'));
    });
  });
}

export type CodexQuotaProbeResult = { type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string };

/** Runs one explicitly requested, isolated Codex turn. It creates no Paws chat session or retained history. */
export async function refreshCodexAccountQuota(api: AccountApi, machineId: string, grant: string): Promise<CodexQuotaProbeResult> {
  let launch: CodexAccountLaunch | undefined;
  let processFinished = false;
  try {
    launch = await CodexAccountLaunch.prepare(api, machineId, grant, { skipHistory: true });
    await runProbeProcess(applyCodexNetworkEnv(launch.environment(process.env)), (pid) => launch!.trackProcess(pid));
    processFinished = true;
    await launch.syncProbeCredential();
    const { accepted } = await launch.reportQuotaProbe();
    return { type: 'success', accepted };
  } catch {
    return { type: 'error', errorMessage: 'Unable to refresh this Codex account quota. Check that the bound device and account are available, then try again.' };
  } finally {
    await (processFinished ? launch?.finish() : launch?.abort())?.catch(() => undefined);
  }
}

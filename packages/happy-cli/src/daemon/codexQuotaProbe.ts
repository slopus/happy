import { tmpdir } from 'node:os';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { AccountApi } from './codexAccountLaunch';
import { CodexAccountLaunch } from './codexAccountLaunch';

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_PROMPT = 'Reply with exactly: ok';

function applyCodexNetworkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxyUrl = env.HAPPY_CODEX_PROXY_URL || env.CODEX_PROXY_URL;
  return proxyUrl ? { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl } : env;
}

async function runProbeTurn(environment: NodeJS.ProcessEnv): Promise<void> {
  // App-server is the same protocol used by Paws Codex sessions. Unlike
  // `codex exec`, it persists the token-count notification (including the
  // weekly rate-limit snapshot) in this temporary CODEX_HOME.
  const client = new CodexAppServerClient(undefined, { type: 'spawn' }, environment);
  try {
    await client.connect();
    await client.startThread({ cwd: tmpdir(), approvalPolicy: 'never', sandbox: 'read-only' });
    const { aborted } = await client.sendTurnAndWait(PROBE_PROMPT, {
      approvalPolicy: 'never',
      sandbox: 'read-only',
      turnTimeoutMs: PROBE_TIMEOUT_MS,
    });
    if (aborted) throw new Error('Codex quota probe did not complete');
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export type CodexQuotaProbeResult = { type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string };

/** Runs one explicitly requested, isolated Codex turn. It creates no Paws chat session or retained history. */
export async function refreshCodexAccountQuota(api: AccountApi, machineId: string, grant: string): Promise<CodexQuotaProbeResult> {
  let launch: CodexAccountLaunch | undefined;
  let processFinished = false;
  try {
    launch = await CodexAccountLaunch.prepare(api, machineId, grant, { skipHistory: true });
    await runProbeTurn(applyCodexNetworkEnv(launch.environment(process.env)));
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

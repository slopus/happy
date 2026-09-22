import { tmpdir } from 'node:os';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { AccountApi } from './codexAccountLaunch';
import { CodexAccountLaunch } from './codexAccountLaunch';
import { prepareCodexQuotaProbe, finishCodexQuotaProbe } from './codexQuotaProbeRecovery';

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_PROMPT = 'Reply with exactly: ok';
class ProbeShutdownError extends Error {}

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
    try { await client.disconnect({ waitForExit: true }); }
    catch { throw new ProbeShutdownError('Codex probe shutdown could not be confirmed'); }
  }
}

export type CodexQuotaProbeResult = { type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string };

/** Runs one explicitly requested, isolated Codex turn. It creates no Paws chat session or retained history. */
export async function refreshCodexAccountQuota(api: AccountApi, machineId: string, grant: string): Promise<CodexQuotaProbeResult> {
  return withCodexQuotaProbe(api, machineId, grant, runProbeTurn);
}

/** Keep credential finalization independent from model, quota parsing and reporting failures. */
export async function withCodexQuotaProbe(
  api: AccountApi, machineId: string, grant: string,
  runTurn: (environment: NodeJS.ProcessEnv) => Promise<void>,
): Promise<CodexQuotaProbeResult> {
  let launch: CodexAccountLaunch | undefined;
  let result: CodexQuotaProbeResult;
  try {
    launch = await prepareCodexQuotaProbe(api, machineId, grant);
    await runTurn(applyCodexNetworkEnv(launch.environment(process.env)));
    await launch.syncProbeCredential();
    const { accepted } = await launch.reportQuotaProbe();
    result = { type: 'success', accepted };
  } catch (error) {
    if (error instanceof ProbeShutdownError) {
      // Keep the home active: neither cleanup nor the background drainer may race a producer.
      return { type: 'error', errorMessage: 'Codex probe shutdown could not be confirmed. Its login files have been preserved on this device.' };
    }
    result = { type: 'error', errorMessage: 'Unable to refresh this Codex account quota. Check that the bound device and account are available, then try again.' };
  }
  if (launch && !await finishCodexQuotaProbe(launch)) {
    return { type: 'error', errorMessage: 'Codex login recovery is pending on this device. The login has been preserved and Paws will retry saving it automatically.' };
  }
  return result;
}

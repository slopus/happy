import { CodexAppServerClient, type CodexAccountRateLimitsResponse } from '@/codex/codexAppServerClient';
import type { AccountApi } from './codexAccountLaunch';
import { CodexAccountLaunch } from './codexAccountLaunch';
import { prepareCodexQuotaProbe, finishCodexQuotaProbe } from './codexQuotaProbeRecovery';

class ProbeShutdownError extends Error {}

function applyCodexNetworkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxyUrl = env.HAPPY_CODEX_PROXY_URL || env.CODEX_PROXY_URL;
  return proxyUrl ? { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl } : env;
}

async function readRateLimits(environment: NodeJS.ProcessEnv): Promise<CodexAccountRateLimitsResponse> {
  const client = new CodexAppServerClient(undefined, { type: 'spawn' }, environment);
  try {
    await client.connect();
    return await client.readAccountRateLimits();
  } finally {
    try { await client.disconnect({ waitForExit: true }); }
    catch { throw new ProbeShutdownError('Codex probe shutdown could not be confirmed'); }
  }
}

export type CodexQuotaProbeResult = { type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string };

/** Reads account rate limits without starting a Codex turn or spending model tokens. */
export async function refreshCodexAccountQuota(api: AccountApi, machineId: string, grant: string): Promise<CodexQuotaProbeResult> {
  return withCodexQuotaProbe(api, machineId, grant, readRateLimits);
}

/** Keep credential finalization independent from rate-limit reads and reporting failures. */
export async function withCodexQuotaProbe(
  api: AccountApi, machineId: string, grant: string,
  readLimits: (environment: NodeJS.ProcessEnv) => Promise<CodexAccountRateLimitsResponse>,
): Promise<CodexQuotaProbeResult> {
  let launch: CodexAccountLaunch | undefined;
  let result: CodexQuotaProbeResult;
  try {
    launch = await prepareCodexQuotaProbe(api, machineId, grant);
    const limits = await readLimits(applyCodexNetworkEnv(launch.environment(process.env)));
    await launch.syncProbeCredential();
    const { accepted } = await launch.reportQuotaProbe(limits);
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

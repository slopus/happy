import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient } from '@/api/api';
import { CodexAccountRequestError } from '@/api/codexAccountTypes';
import { codexAccountAuthSchema, readCodexAccountAuth, type CodexAccountAuth } from '@/codex/codexAccountAuth';
import { prepareCodexHomeWithAuth } from '@/codex/codexHome';
import { collectCodexUsageSnapshot, type CodexUsageRateLimitWindow, type CodexUsageRateLimits } from '@/codex/codexUsage';
import { retainCodexAccountHistory, restoreCodexAccountHistory, rememberCodexAccountSession, copyCodexSourceThread, getCodexSourceAccountProfileId, CodexSourceHistoryUnavailableError, CodexSourceAccountMismatchError } from '@/codex/codexAccountHistory';
import { configuration } from '@/configuration';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { CODEX_ACCOUNT_UNSET_ENV } from '@/codex/codexAccountConfig';
import { writeCodexAccountLaunchState, type CodexAccountLaunchState } from '@/codex/codexAccountLaunchState';
export { CODEX_ACCOUNT_UNSET_ENV } from '@/codex/codexAccountConfig';

export type AccountApi = Pick<ApiClient, 'redeemCodexSessionGrant' | 'attachCodexSession' | 'updateCodexAccountCredential' | 'reportCodexAccountQuota' | 'reportCodexAccountStatus'>
  & Partial<Pick<ApiClient, 'reportCodexAccountQuotaProbe'>>;
type PrepareOptions = NonNullable<Parameters<typeof prepareCodexHomeWithAuth>[1]> & { historyRoot?: string; sourceSessionId?: string; sourceThreadId?: string; sourceProfileId?: string; skipHistory?: boolean };
const fingerprint = (auth: CodexAccountAuth) => createHash('sha256').update(JSON.stringify(auth)).digest('hex');
const identityFingerprint = (launchId: string, accountId: string) => createHash('sha256').update(`${launchId}\0${accountId}`).digest('hex');

/** Codex currently emits the weekly window as secondary, but newer clients can emit it as primary. */
function weeklyRateLimit(rateLimits: CodexUsageRateLimits | undefined): CodexUsageRateLimitWindow | undefined {
  const secondary = rateLimits?.secondary;
  if (secondary && (secondary.windowMinutes === undefined || secondary.windowMinutes === 10080)) return secondary;
  const primary = rateLimits?.primary;
  return primary?.windowMinutes === 10080 ? primary : undefined;
}

/** One redeemed launch owns one home and immutable quota attribution. */
export class CodexAccountLaunch {
  readonly profileId: string;
  readonly launchId: string;
  readonly credentialVersion: number;
  private currentVersion: number;
  private authFingerprint: string;
  private readonly accountFingerprint: string;
  private sourceSessionId?: string;
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> = Promise.resolve();
  private finishing?: Promise<void>;
  private attaching?: Promise<void>;
  private writeDisabled = false;
  private lastQuota?: string;
  private pid?: number;
  private readonly startedAt: number;
  private readonly daemonPid: number;
  private identityInvalid = false;

  private constructor(private readonly api: AccountApi, private readonly machineId: string, readonly home: string, state: CodexAccountLaunchState, private readonly historyRoot: string) {
    this.profileId = state.profileId; this.launchId = state.launchId;
    this.credentialVersion = state.credentialVersion; this.currentVersion = state.currentVersion;
    this.authFingerprint = state.authFingerprint; this.accountFingerprint = state.accountFingerprint;
    this.startedAt = state.startedAt; this.daemonPid = state.daemonPid;
    this.sourceSessionId = state.sourceSessionId; this.writeDisabled = state.writeDisabled;
    this.identityInvalid = state.identityInvalid; this.lastQuota = state.lastQuota;
  }

  /** Only the surviving worker may recover this observer, after daemon death. */
  static recover(api: AccountApi, home: string, state: CodexAccountLaunchState): CodexAccountLaunch {
    return new CodexAccountLaunch(api, state.machineId, home, state, state.historyRoot);
  }

  private checkpoint(): Promise<void> {
    return writeCodexAccountLaunchState(this.home, {
      schemaVersion: 1, daemonPid: this.daemonPid, machineId: this.machineId,
      profileId: this.profileId, launchId: this.launchId, credentialVersion: this.credentialVersion,
      currentVersion: this.currentVersion, authFingerprint: this.authFingerprint, accountFingerprint: this.accountFingerprint,
      sourceSessionId: this.sourceSessionId, historyRoot: this.historyRoot, startedAt: this.startedAt,
      writeDisabled: this.writeDisabled, identityInvalid: this.identityInvalid, lastQuota: this.lastQuota,
    });
  }

  static async prepare(api: AccountApi, machineId: string, grant: string | undefined, options?: PrepareOptions): Promise<CodexAccountLaunch> {
    if (typeof grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant)) throw new Error('A fresh Codex session grant is required. Check the binding in Settings → Device Environment.');
    const redeemed = await api.redeemCodexSessionGrant({ machineId, grant });
    const parsed = codexAccountAuthSchema.safeParse(redeemed.auth);
    if (!parsed.success || !redeemed.launchId || !redeemed.profile?.id || !Number.isInteger(redeemed.profile.credentialVersion) || redeemed.profile.credentialVersion < 1) {
      throw new Error('Invalid Codex grant response');
    }
    const home = await prepareCodexHomeWithAuth(JSON.stringify(parsed.data), options);
    const historyRoot = options?.historyRoot ?? join(configuration.happyHomeDir, 'codex-session-cache');
    try {
      if (!options?.skipHistory) {
        await restoreCodexAccountHistory(historyRoot, redeemed.profile.id, home);
        if (options?.sourceThreadId) await copyCodexSourceThread(historyRoot, options.sourceSessionId ?? '', options.sourceThreadId, home, redeemed.profile.id);
      }
      const launch = new CodexAccountLaunch(api, machineId, home, {
        schemaVersion: 1, daemonPid: process.pid, machineId, profileId: redeemed.profile.id, launchId: redeemed.launchId,
        credentialVersion: redeemed.profile.credentialVersion, currentVersion: redeemed.profile.credentialVersion,
        authFingerprint: fingerprint(parsed.data), accountFingerprint: identityFingerprint(redeemed.launchId, parsed.data.tokens.account_id),
        historyRoot, startedAt: Date.now(), writeDisabled: false, identityInvalid: false,
      }, historyRoot);
      await launch.checkpoint();
      return launch;
    }
    catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error instanceof CodexSourceHistoryUnavailableError || error instanceof CodexSourceAccountMismatchError
        ? error
        : new Error('Unable to restore Codex session history');
    }
  }

  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: this.home, HAPPY_CODEX_APP_SERVER_MODE: 'spawn',
      HAPPY_CODEX_ACCOUNT_PROFILE_ID: this.profileId, HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION: String(this.credentialVersion),
    };
    for (const key of CODEX_ACCOUNT_UNSET_ENV) delete env[key];
    return env;
  }

  /** Publish the rate-limit event produced by an explicit, no-history quota probe. */
  async reportQuotaProbe(): Promise<{ accepted: boolean }> {
    const snapshot = await collectCodexUsageSnapshot({ codexHome: this.home, maxDays: 1 });
    const event = snapshot.latestEvent;
    const weekly = weeklyRateLimit(event?.rateLimits);
    const observed = event?.rateLimitsTimestamp;
    if (typeof weekly?.usedPercent !== 'number' || !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 0 || weekly.usedPercent > 100 ||
        typeof weekly.resetsAt !== 'number' || !Number.isFinite(weekly.resetsAt) || !observed || !Number.isFinite(Date.parse(observed)) || Date.parse(observed) < this.startedAt) {
      throw new Error('Codex did not return a current weekly quota snapshot');
    }
    const reset = new Date(weekly.resetsAt * 1000);
    if (!Number.isFinite(reset.getTime()) || reset.getTime() <= Date.parse(observed)) throw new Error('Codex returned an invalid weekly quota reset time');
    if (!this.api.reportCodexAccountQuotaProbe) throw new Error('This Paws daemon does not support quota probes');
    return this.api.reportCodexAccountQuotaProbe(this.profileId, {
      machineId: this.machineId, launchId: this.launchId, credentialVersion: this.credentialVersion,
      weeklyUsedPercent: weekly.usedPercent, weeklyResetsAt: reset.toISOString(), observedAt: observed,
    });
  }

  /** A probe has no Happy session, but Codex may still rotate its OAuth token. */
  async syncProbeCredential(): Promise<void> {
    const auth = await readCodexAccountAuth(this.home).catch(() => undefined);
    if (!auth) throw new Error('Codex quota probe could not read its refreshed login');
    if (identityFingerprint(this.launchId, auth.tokens.account_id) !== this.accountFingerprint) throw new Error('Codex quota probe identity changed unexpectedly');
    if (fingerprint(auth) === this.authFingerprint) return;
    if (!this.api.updateCodexAccountCredential) throw new Error('This Paws daemon cannot save a refreshed Codex login');
    const result = await this.api.updateCodexAccountCredential(this.profileId, {
      machineId: this.machineId, launchId: this.launchId, expectedVersion: this.currentVersion, auth,
    });
    this.currentVersion = result.profile.credentialVersion;
    this.authFingerprint = fingerprint(auth);
    await this.checkpoint();
  }

  trackProcess(pid: number): void { this.pid = pid; }

  async attach(sourceSessionId: string): Promise<void> {
    if (this.finishing) throw new Error('Codex process exited before session attachment');
    if (!this.attaching) this.attaching = (async () => {
      await this.api.attachCodexSession(this.launchId, { machineId: this.machineId, sourceSessionId });
      if (this.finishing) throw new Error('Codex process exited before session attachment');
      await rememberCodexAccountSession(this.historyRoot, sourceSessionId, this.profileId, this.home);
      if (this.finishing) throw new Error('Codex process exited before session attachment');
      this.sourceSessionId = sourceSessionId;
      await this.checkpoint();
      if (this.finishing) throw new Error('Codex process exited before session attachment');
      this.timer = setInterval(() => { void this.sync(); }, 60_000);
      this.timer.unref();
    })();
    await this.attaching;
  }

  async reportStatus(status: 'needs-refresh' | 'invalid'): Promise<void> {
    if (!this.sourceSessionId || this.writeDisabled) return;
    try {
      await this.api.reportCodexAccountStatus(this.profileId, { machineId: this.machineId, launchId: this.launchId, credentialVersion: this.currentVersion, status });
    } catch { /* Status cannot interrupt the running session; no raw error logging. */ }
  }

  sync(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.pending = this.pending.then(async () => { await this.syncOnce(); await this.checkpoint(); }).catch(() => undefined);
    return this.pending;
  }

  /** Copy the live rollout into the profile cache before an attributed usage scan. */
  async retainUsageHistory(): Promise<void> {
    if (!this.sourceSessionId || this.identityInvalid) return;
    await retainCodexAccountHistory(this.historyRoot, this.profileId, this.home);
  }

  private async syncOnce(): Promise<void> {
    if (!this.sourceSessionId) return;
    // A stale writer still owns quota observations, so identity validation must
    // continue independently of whether it is allowed to update credentials.
    let auth: CodexAccountAuth | undefined;
    try { auth = await readCodexAccountAuth(this.home); }
    catch { await this.reportStatus('needs-refresh'); }
    if (auth && identityFingerprint(this.launchId, auth.tokens.account_id) !== this.accountFingerprint) {
      await this.reportStatus('invalid'); this.writeDisabled = true; this.identityInvalid = true;
    } else if (!this.writeDisabled && auth && fingerprint(auth) !== this.authFingerprint) {
      try {
        const result = await this.api.updateCodexAccountCredential(this.profileId, { machineId: this.machineId, launchId: this.launchId, expectedVersion: this.currentVersion, auth });
        this.currentVersion = result.profile.credentialVersion;
        this.authFingerprint = fingerprint(auth);
      } catch (error) {
        if (error instanceof CodexAccountRequestError && ['credential-version-conflict', 'profile-not-found', 'launch-unavailable', 'credential-identity-mismatch'].includes(error.code)) this.writeDisabled = true;
      }
    }
    if (this.identityInvalid) return;
    try {
      const snapshot = await collectCodexUsageSnapshot({ codexHome: this.home, maxDays: 8 });
      const event = snapshot.latestEvent;
      const weekly = weeklyRateLimit(event?.rateLimits);
      const observed = event?.rateLimitsTimestamp;
      if (typeof weekly?.usedPercent !== 'number' || !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 0 || weekly.usedPercent > 100 ||
          typeof weekly.resetsAt !== 'number' || !Number.isFinite(weekly.resetsAt) || !observed || !Number.isFinite(Date.parse(observed)) || Date.parse(observed) < this.startedAt) return;
      const reset = new Date(weekly.resetsAt * 1000);
      if (!Number.isFinite(reset.getTime()) || reset.getTime() <= Date.parse(observed)) return;
      const signature = JSON.stringify([weekly.usedPercent, weekly.resetsAt, observed]);
      if (signature === this.lastQuota) return;
      await this.api.reportCodexAccountQuota(this.profileId, {
        machineId: this.machineId, launchId: this.launchId, sourceSessionId: this.sourceSessionId,
        credentialVersion: this.credentialVersion, weeklyUsedPercent: weekly.usedPercent,
        weeklyResetsAt: reset.toISOString(), observedAt: observed,
      });
      this.lastQuota = signature;
    } catch { /* Retry next minute; never publish warnings or provider error text. */ }
  }

  finish(): Promise<void> {
    if (!this.finishing) {
      clearInterval(this.timer);
      this.finishing = Promise.allSettled([this.pending, this.attaching]).then(() => this.syncOnce()).catch(() => undefined)
        .then(async () => {
          try { if (this.sourceSessionId && !this.identityInvalid) await retainCodexAccountHistory(this.historyRoot, this.profileId, this.home); }
          finally { await rm(this.home, { recursive: true, force: true }); }
        });
    }
    return this.finishing;
  }

  async abort(): Promise<void> {
    if (this.pid) { try { process.kill(this.pid, 'SIGTERM'); } catch { /* Already gone. */ } }
    await this.finish();
  }
}

export async function withCodexAccountLaunch(
  options: Pick<SpawnSessionOptions, 'agent' | 'codexSessionGrant' | 'token'>,
  api: AccountApi, machineId: string,
  spawn: (launch: CodexAccountLaunch | undefined) => Promise<SpawnSessionResult>,
  prepareOptions?: PrepareOptions,
): Promise<SpawnSessionResult> {
  if (options.agent !== 'codex') return spawn(undefined);
  let launch: CodexAccountLaunch | undefined;
  try {
    // A binding remains optional for new or legacy-local sessions. An audited
    // managed session must not silently resume under the machine's local login.
    if (options.codexSessionGrant === undefined) {
      if (prepareOptions?.sourceProfileId) throw new CodexSourceAccountMismatchError();
      if (prepareOptions?.sourceThreadId && prepareOptions.sourceSessionId) {
        const historyRoot = prepareOptions.historyRoot ?? join(configuration.happyHomeDir, 'codex-session-cache');
        if (await getCodexSourceAccountProfileId(historyRoot, prepareOptions.sourceSessionId)) {
          throw new CodexSourceAccountMismatchError();
        }
      }
      return spawn(undefined);
    }
    launch = await CodexAccountLaunch.prepare(api, machineId, options.codexSessionGrant, prepareOptions);
    const result = await spawn(launch);
    if (result.type === 'success') await launch.attach(result.sessionId);
    else await launch.abort();
    return result;
  } catch (error) {
    await launch?.abort().catch(() => undefined);
    return { type: 'error', errorMessage: error instanceof CodexSourceHistoryUnavailableError || error instanceof CodexSourceAccountMismatchError
      ? error.message
      : 'Codex account launch failed. Check the account binding in Settings → Device Environment and start the session again.' };
  }
}

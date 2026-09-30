import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient } from '@/api/api';
import { CodexAccountRequestError } from '@/api/codexAccountTypes';
import { codexAccountAuthSchema, readCodexAccountAuth } from './codexAccountAuth';
import { readCodexAccountLaunchState } from './codexAccountLaunchState';
import { writeCodexCredentialAdoption } from './codexCredentialAdoption';

type CredentialApi = Pick<ApiClient, 'readCodexSessionCredential' | 'reportCodexAccountStatus'>;

function waitForPoll(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(true); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** 等待原 Paws 账号获得新版凭证，再恢复失败的回合。 */
export class CodexSessionCredentialRecovery {
  private knownVersion?: number;

  constructor(
    private readonly api: CredentialApi,
    private readonly home: string,
    private readonly machineId: string,
    private readonly sourceSessionId: string,
  ) { }

  async waitForNewCredential(options: {
    signal: AbortSignal;
    onWaiting: () => void;
    pollIntervalMs?: number;
  }): Promise<boolean> {
    const state = await readCodexAccountLaunchState(this.home);
    if (state.machineId !== this.machineId || state.sourceSessionId !== this.sourceSessionId || state.identityInvalid) {
      throw new Error('Codex session account ownership changed');
    }
    this.knownVersion ??= state.currentVersion;
    const previous = await readCodexAccountAuth(this.home);
    const accountFingerprint = createHash('sha256')
      .update(`${state.launchId}\0${previous.tokens.account_id}`).digest('hex');
    if (accountFingerprint !== state.accountFingerprint) throw new Error('Codex session account identity changed');

    let reported = false;
    let waitingNotified = false;
    while (!options.signal.aborted) {
      try {
        const current = await this.api.readCodexSessionCredential(state.launchId, {
          machineId: this.machineId, sourceSessionId: this.sourceSessionId, knownVersion: this.knownVersion,
        });
        if (current.profileId !== state.profileId) throw new Error('Codex session account identity changed');
        if (current.status === 'available' && current.credentialVersion > this.knownVersion && current.auth) {
          const auth = codexAccountAuthSchema.parse(current.auth);
          if (auth.tokens.account_id !== previous.tokens.account_id) throw new Error('Codex session account identity changed');
          const temporary = join(this.home, `.paws-auth-recovery-${randomUUID()}`);
          try {
            await writeFile(temporary, JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
            await rename(temporary, join(this.home, 'auth.json'));
          } finally { await rm(temporary, { force: true }); }
          await writeCodexCredentialAdoption(this.home, {
            launchId: state.launchId, profileId: state.profileId,
            credentialVersion: current.credentialVersion,
            authFingerprint: createHash('sha256').update(JSON.stringify(auth)).digest('hex'),
            accountFingerprint: state.accountFingerprint,
          }).catch(() => undefined);
          this.knownVersion = current.credentialVersion;
          return true;
        }
        if (current.status === 'available' && !reported && current.credentialVersion === this.knownVersion) {
          reported = true;
          await this.api.reportCodexAccountStatus(state.profileId, {
            machineId: this.machineId, launchId: state.launchId,
            credentialVersion: this.knownVersion, status: 'needs-refresh',
          }).catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Codex session account identity changed') throw error;
        if (error instanceof CodexAccountRequestError &&
          ['launch-unavailable', 'session-unavailable', 'profile-not-found', 'machine-not-found'].includes(error.code)) throw error;
        // 中继暂时不可用时，保留用户待处理的消息。
      }
      if (!waitingNotified) { options.onWaiting(); waitingNotified = true; }
      if (!await waitForPoll(options.pollIntervalMs ?? 10_000, options.signal)) return false;
    }
    return false;
  }
}

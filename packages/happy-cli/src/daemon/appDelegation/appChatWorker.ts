import { createWorkerWake } from './workerWake';
import type { NativeSessionHooks } from './nativeSessionRuntime';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedServiceWorker } from './sharedServiceWorker';
import { acquireMachineLock } from './workerLock';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { Machine } from '@/api/types';
import type { AccountApi } from '@/daemon/codexAccountLaunch';
import { verifyRestrictedCodex } from './restrictedCodex';
import { verifyRestrictedClaude } from './restrictedClaude';

export { createBoundServiceRuntime } from './executionBinding';
export { recoverAppChatCredentialJobs } from './credentialRecovery';
export type { TrustedApplicationLoader, TrustedBusinessPromptResolver } from './applicationPolicy';
export type { BoundRuntimeContext, BoundCredentialLease, BoundWorkspace, BoundTurnInput, BoundTurnEvent, BoundServiceRuntime } from './executionBinding';

/** Runs only ai-services/1 discovery, execution and native session history. */
export function startAppChatWorker(token: string, machine: Machine, nativeSessionHooks?: NativeSessionHooks, subscribeWake?: (wake: () => void) => (() => void)): () => void {
    const lifetime = new AbortController();
    const wake = createWorkerWake(lifetime.signal);
    const unsubscribeWake = subscribeWake?.(() => wake.notify());
    lifetime.signal.addEventListener('abort', () => unsubscribeWake?.(), { once: true });
    const configuredBinary = process.env.HAPPY_CODEX_PATH?.trim();
    const claudeBinary = process.env.HAPPY_CLAUDE_PATH?.trim() || 'claude';
    const binary = configuredBinary && isAbsolute(configuredBinary) ? configuredBinary : 'codex';
    const request = async <T>(path: string, body: unknown, method = 'POST', cleanup = false): Promise<T> => {
        const response = await fetch(`${configuration.serverUrl}/v1/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: cleanup ? AbortSignal.timeout(7000) : AbortSignal.any([lifetime.signal, AbortSignal.timeout(7000)]), redirect: 'error' });
        if (response.status === 413) throw new Error('snapshot-too-large');
        const data = await response.json() as any;
        const validation = typeof data?.message === 'string' ? data.message : '';
        if (!response.ok && (data?.error?.code === 'snapshot-too-large' || response.status === 400 && /output|ciphertext/.test(validation) && /too big|too_big|maximum|max.*characters/i.test(validation))) throw new Error('snapshot-too-large');
        if (response.status === 404 && path.startsWith('ai-service-worker/')) throw new Error('shared-protocol-unavailable');
        if (!response.ok) {
            const error=new Error(response.status === 409 && data.error === 'codex-account-unbound' ? 'codex-account-unbound' : 'authorization-unavailable');
            const code=typeof data?.error==='string' ? data.error : data?.error?.code;
            if(path.includes('/history/'))Object.assign(error,{code:`history-http-${response.status}-${typeof code==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : 'unknown'}`});
            throw error;
        }
        return data as T;
    };
    const api: AccountApi = {
        redeemCodexSessionGrant: data => request('codex-session-grants/redeem', data),
        attachCodexSession: (id, data) => request(`codex-session-grants/${id}/session`, data),
        updateCodexAccountCredential: (id, data) => request(`codex-accounts/${id}/credential`, data, 'PUT', true),
        reportCodexAccountQuota: (id, data) => request(`codex-accounts/${id}/quota-snapshot`, data, 'PUT', true),
        reportCodexAccountStatus: (id, data) => request(`codex-accounts/${id}/status`, data, 'PUT', true),
    };
    const shared = createSharedServiceWorker({ machine, request, api, recoveryRoot: join(configuration.happyHomeDir, 'ai-service-credentials', createHash('sha256').update(machine.id).digest('hex')), lifetime: lifetime.signal, codexBinary: binary, claudeBinary, nativeSessionHooks });
    void (async () => {
        if (configuredBinary && !isAbsolute(configuredBinary)) return;
        const readiness = await Promise.all([verifyRestrictedCodex(binary), verifyRestrictedClaude(claudeBinary)]);
        const engines = ['codex', 'claude'].filter((_, index) => readiness[index]);
        if (!engines.length && !nativeSessionHooks) return;
        let release: (() => Promise<void>) | null = null;
        while (!lifetime.signal.aborted && !release) {
            release = await acquireMachineLock(machine.id, () => lifetime.abort());
            if (!release) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!release) return;
        let historyBusy=false;
        const historyTimer=setInterval(()=>{if(historyBusy||lifetime.signal.aborted)return;historyBusy=true;void shared.tickHistory().catch(error=>{
            const value=error instanceof Error ? error : undefined;
            const code=(value as Error & {code?:unknown})?.code ?? value?.message;
            logger.debug('[APP CHAT] Native history sync failed',{
                errorCode:typeof code==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : 'history-sync-failed',
                stackFrames:value?.stack?.split('\n').slice(1,4).filter(line=>/^\s+at /.test(line)),
            });
        }).finally(()=>{historyBusy=false;});},1000);
        try { while (!lifetime.signal.aborted) {
            try {
                if (await shared.tick()) continue;
            } catch { /* Failed claim leaves no running turn; retry after bounded delay. */ }
            await wake.wait();
        } } finally { clearInterval(historyTimer); await release(); }
    })();
    return () => { lifetime.abort();  };
}

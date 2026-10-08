import type { NativeSessionHooks } from './nativeSessionRuntime';
/** Bounded leased worker for application-owned chats; independent of unrestricted RPC. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseAppChatSelection, type AppChatSelection } from '@slopus/happy-wire';
import { runRestrictedClaude, verifyRestrictedClaude } from './restrictedClaude';
import { createSharedServiceWorker } from './sharedServiceWorker';
import { acquireMachineLock } from './workerLock';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { Machine } from '@/api/types';
import { decodeBase64, decrypt, decryptLegacy, encodeBase64, encryptLegacy } from '@/api/encryption';
import { recoverAppChatCredentialJobs } from './credentialRecovery';
import { createRuntimeProcessGuard } from './runtimeProcessState';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';
import { runRestrictedCodex, verifyRestrictedCodex } from './restrictedCodex';

/** T4 composes this runtime with authenticated discovery and turn credential grants. Legacy claims below stay on their original protocol. */
export { createBoundServiceRuntime } from './executionBinding';
export { recoverAppChatCredentialJobs } from './credentialRecovery';
export type { TrustedApplicationLoader, TrustedBusinessPromptResolver } from './applicationPolicy';
export type { BoundRuntimeContext, BoundCredentialLease, BoundWorkspace, BoundTurnInput, BoundTurnEvent, BoundServiceRuntime } from './executionBinding';

interface Job { protocol?: number; id: string; conversationId: string; grantId: string; appId: string; machineId: string; expiresAt: string | null; envelope: string; input: string; lease: string }
const messageSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(500_000), selection: z.object({ engine: z.enum(['codex', 'claude']), model: z.string().max(100) }).strict().optional(), actualModel: z.string().max(100).optional(), images: z.array(z.string().max(3_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).max(4).optional() }).strict();

const activeHomes = new Set<string>();

export function startAppChatWorker(token: string, machine: Machine, nativeSessionHooks?: NativeSessionHooks): () => void {
    const lifetime = new AbortController();
    let active: AbortController | null = null;
    let recoveryWarning = false;
    const configuredBinary = process.env.HAPPY_CODEX_PATH?.trim();
    const claudeBinary = process.env.HAPPY_CLAUDE_PATH?.trim() || 'claude';
    let engines: string[] = [];
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
    const recoveryRoot = join(configuration.happyHomeDir, 'app-chat-credentials', createHash('sha256').update(machine.id).digest('hex'));
    const api: AccountApi = {
        redeemCodexSessionGrant: data => request('codex-session-grants/redeem', data),
        attachCodexSession: (id, data) => request(`codex-session-grants/${id}/session`, data),
        updateCodexAccountCredential: (id, data) => request(`codex-accounts/${id}/credential`, data, 'PUT', true),
        reportCodexAccountQuota: (id, data) => request(`codex-accounts/${id}/quota-snapshot`, data, 'PUT', true),
        reportCodexAccountStatus: (id, data) => request(`codex-accounts/${id}/status`, data, 'PUT', true),
    };
    const shared = createSharedServiceWorker({ machine, request, api, recoveryRoot: join(configuration.happyHomeDir, 'ai-service-credentials', createHash('sha256').update(machine.id).digest('hex')), lifetime: lifetime.signal, codexBinary: binary, claudeBinary, nativeSessionHooks });
    const recoverCredentials = () => recoverAppChatCredentialJobs(recoveryRoot, machine.id, api, activeHomes);
    const execute = async (job: Job) => {
        const control = new AbortController(); active = control;
        const stop = () => control.abort(); lifetime.signal.addEventListener('abort', stop, { once: true });
        let root: string | undefined;
        let launch: CodexAccountLaunch | undefined;
        let heartbeat: NodeJS.Timeout | undefined;
        let flushing: Promise<unknown> = Promise.resolve();
        let encode: (() => string) | undefined;
        let selection: AppChatSelection | undefined, actualModel: string | undefined, publicError: string | undefined;
        let latest = ''; let sent = ''; let sequence = 0;
        const publish = (data: object) => request(`app-worker/${encodeURIComponent(machine.id)}/turns/${job.id}`, { lease: job.lease, ...data });
        try {
            const envelope = decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(job.envelope));
            if (!envelope || envelope.v !== 1 || envelope.grantId !== job.grantId || envelope.appId !== job.appId || job.appId !== 'relationship-advisor' || envelope.machineId !== machine.id || job.machineId !== machine.id || envelope.expiresAt !== job.expiresAt || (job.expiresAt !== null && (!Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= Date.now())) || !['codex:chat', 'agent:chat'].includes(envelope.scope) || ((job.protocol ?? 1) >= 3 ? envelope.scope !== 'agent:chat' || envelope.protocol !== 3 : envelope.scope !== 'codex:chat') || typeof envelope.key !== 'string') throw new Error('invalid-grant-binding');
            const key = decodeBase64(envelope.key); if (key.length !== 32) throw new Error('invalid-key');
            const payload = decryptLegacy(decodeBase64(job.input), key);
            if (!payload || ![1, 2].includes(payload.v) || payload.grantId !== job.grantId || payload.conversationId !== job.conversationId || payload.turnId !== job.id || payload.direction !== 'input' || payload.sequence !== 0) throw new Error('invalid-message-binding');
            if ((payload.v === 2) !== (payload.selection !== undefined)) throw new Error('invalid-selection-protocol');
            selection = parseAppChatSelection(payload.selection);
            if (selection.engine === 'claude' && envelope.scope !== 'agent:chat') throw new Error('claude-not-authorized');
            const messages = z.array(messageSchema).min(1).max(100).parse(payload.messages);
            if (messages.at(-1)?.role !== 'user') throw new Error('invalid-turn');
            encode = () => encodeBase64(encryptLegacy({ v: payload.v, grantId: job.grantId, conversationId: job.conversationId, turnId: job.id, direction: 'output', sequence: ++sequence, text: latest, ...(payload.selection ? { selection } : {}), actualModel, error: publicError }, key));
            heartbeat = setInterval(() => {
                flushing = flushing.then(async () => {
                    if (control.signal.aborted) return;
                    if (latest !== sent) { const snapshot = latest; const output = encode!(); await publish({ output, sequence }); sent = snapshot; }
                    else await publish({});
                }).catch(() => control.abort());
            }, 3000);
            root = await mkdtemp(join(recoveryRoot, 'job-')); activeHomes.add(root);
            const cwd = join(root, 'empty'); await mkdir(cwd, { mode: 0o700 });
            if (!engines.includes(selection.engine)) throw new Error('engine-unavailable');
            if (selection.engine === 'claude') {
                await publish({}); control.signal.throwIfAborted();
                latest = await runRestrictedClaude(claudeBinary, cwd, messages, control.signal, text => { latest = text; }, selection.model, model => { actualModel = model; });
            } else {
                const home = join(root, 'codex'); await mkdir(home, { mode: 0o700 });
                const grant = await request<{ grant: string }>('codex-session-grants', { machineId: machine.id });
                launch = await CodexAccountLaunch.prepare(api, machine.id, grant.grant, { sourceHome: cwd, createTempDir: () => home, skipHistory: true });
                await publish({}); control.signal.throwIfAborted();
                await writeFile(join(root, '.runtime-started'), '1', { mode: 0o600 });
                latest = await runRestrictedCodex(binary, home, cwd, messages, control.signal, text => { latest = text; }, async pid => { await writeFile(join(root!, '.runtime-pid'), String(pid), { mode: 0o600 }); }, selection.model, model => { actualModel = model; }, undefined, createRuntimeProcessGuard(root));
            }
            clearInterval(heartbeat); heartbeat = undefined; await flushing;
            control.signal.throwIfAborted();
            const output = encode!(); await publish({ output, sequence, state: 'completed' });
        } catch (error) {
            control.abort();
            await flushing;
            publicError = selection?.engine === 'claude' ? 'Claude Code 未能完成回答，请检查设备上的 Claude 登录或 API 配置。' : 'Codex 未能完成回答，请检查设备绑定的账号与模型权限。';
            const output = encode?.();
            await publish({ state: 'failed', ...(output ? { output, sequence } : {}) }).catch(() => undefined);
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            await flushing;
            let saved = !launch;
            if (launch) { try { await launch.syncProbeCredential(); saved = true; } catch { /* Keep private auth/checkpoint for retry. */ } }
            if (root && saved) await rm(root, { recursive: true, force: true });
            if (root) activeHomes.delete(root);
            lifetime.signal.removeEventListener('abort', stop); active = null;
        }
    };
    void (async () => {
        if (configuredBinary && !isAbsolute(configuredBinary)) return;
        const readiness = await Promise.all([verifyRestrictedCodex(binary), verifyRestrictedClaude(claudeBinary)]);
        engines = ['codex', 'claude'].filter((_, index) => readiness[index]);
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
                if (!await recoverCredentials()) {
                    if (!recoveryWarning) logger.debug('[APP CHAT] Credential recovery pending: retained private job directory; check old daemon/runtime before manual recovery.');
                    recoveryWarning = true;
                    throw new Error('credential-recovery-pending');
                }
                recoveryWarning = false;
                try { if (await shared.tick()) continue; } catch (error) { if (!(error instanceof Error) || error.message !== 'shared-protocol-unavailable') throw error; }
                const { job } = await request<{ job: Job | null }>(`app-worker/${encodeURIComponent(machine.id)}/claim`, { protocol: 3, engines });
                if (job) await execute(job);
            } catch { /* Failed claim leaves no running turn; retry after bounded delay. */ }
            if (!lifetime.signal.aborted) await new Promise<void>(resolve => {
                const timer = setTimeout(done, 1000);
                function done() { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); }
                lifetime.signal.addEventListener('abort', done, { once: true });
            });
        } } finally { clearInterval(historyTimer); await release(); }
    })();
    return () => { lifetime.abort(); active?.abort(); };
}

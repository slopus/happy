import { mkdir, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { ConversationItem } from './history';
export type CrossAgentRequest = { sourceSessionId: string; targetAgent: 'claude' | 'codex'; requestId: string; codexSessionGrant?: string };
export type ContinuationSource = { id: string; agent: 'claude' | 'codex'; nativeId: string; directory: string; running: boolean; application: boolean; accountProfileId?: string; requiresImportedHistory?: boolean; revision?: number; stateVersion?: number };
export type CrossAgentSpawn = { agent: 'claude' | 'codex'; directory: string; parentSessionId: string; approvedNewDirectoryCreation: false; crossAgentHistory: ConversationItem[]; crossAgentRequestId: string; codexSessionGrant?: string };
type Dependencies = {
    root: string;
    resolveSource: (id: string) => Promise<ContinuationSource>;
    exportHistory: (source: ContinuationSource) => Promise<ConversationItem[]>;
    findCreated?: (request: CrossAgentRequest) => Promise<string | undefined>;
    spawn: (options: CrossAgentSpawn) => Promise<SpawnSessionResult>;
};
type Receipt = { sourceSessionId: string; targetAgent: string; phase: 'starting' | 'ready'; sessionId?: string };

/** Durable request receipts outlive transport errors. Never blindly repeat a launch. */
export function createCrossAgentContinuation(deps: Dependencies) {
    const pending = new Map<string, { source: string; target: string; promise: Promise<SpawnSessionResult> }>();
    async function perform(request: CrossAgentRequest): Promise<SpawnSessionResult> {
        const path = join(deps.root, `${request.requestId}.json`);
        let receipt: Receipt | undefined;
        try { receipt = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (receipt) {
            if (receipt.sourceSessionId !== request.sourceSessionId || receipt.targetAgent !== request.targetAgent) throw new Error('Continuation request identity mismatch');
            if (receipt.phase === 'ready' && receipt.sessionId) return { type: 'success', sessionId: receipt.sessionId };
            const recovered = await deps.findCreated?.(request);
            if (recovered) {
                await writeFile(path, JSON.stringify({ ...receipt, phase: 'ready', sessionId: recovered }), { mode: 0o600 });
                return { type: 'success', sessionId: recovered };
            }
            throw new Error('Continuation launch outcome is unknown. Check the session list before starting another continuation.');
        }
        const source = await deps.resolveSource(request.sourceSessionId);
        if (source.application) throw new Error('Application-owned sessions cannot be converted');
        if (source.running) throw new Error('Wait for the source session to finish running or stop it first');
        if (source.agent === request.targetAgent) throw new Error('Select a different agent for cross-agent continuation');
        const history = await deps.exportHistory(source);
        // Recheck after export; a different device may have submitted another turn.
        const current = await deps.resolveSource(request.sourceSessionId);
        if (current.running || current.application || current.agent !== source.agent || current.nativeId !== source.nativeId || current.directory !== source.directory || current.revision !== source.revision || current.stateVersion !== source.stateVersion) throw new Error('Source session changed while preparing history; try again after it finishes');
        await mkdir(deps.root, { recursive: true, mode: 0o700 });
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ sourceSessionId: source.id, targetAgent: request.targetAgent, phase: 'starting' })); await file.sync(); }
        finally { await file.close(); }
        const result = await deps.spawn({ agent: request.targetAgent, directory: source.directory, parentSessionId: source.id,
            approvedNewDirectoryCreation: false, crossAgentHistory: history, crossAgentRequestId: request.requestId,
            ...(request.targetAgent === 'codex' && request.codexSessionGrant ? { codexSessionGrant: request.codexSessionGrant } : {}) });
        if (result.type === 'requestToApproveDirectoryCreation' || (result.type === 'error' && result.notDispatched)) await rm(path, { force: true });
        if (result.type === 'success') {
            const temp = `${path}.tmp`;
            await writeFile(temp, JSON.stringify({ sourceSessionId: source.id, targetAgent: request.targetAgent, phase: 'ready', sessionId: result.sessionId }), { mode: 0o600 });
            await rename(temp, path);
        }
        return result;
    }
    return (request: CrossAgentRequest): Promise<SpawnSessionResult> => {
        if (!request || !/^[a-f0-9-]{36}$/i.test(request.requestId) || !request.sourceSessionId || !['claude', 'codex'].includes(request.targetAgent)) return Promise.reject(new Error('Invalid cross-agent continuation request'));
        const existing = pending.get(request.requestId);
        if (existing) return existing.source === request.sourceSessionId && existing.target === request.targetAgent ? existing.promise : Promise.reject(new Error('Continuation request identity mismatch'));
        const promise = perform(request);
        pending.set(request.requestId, { source: request.sourceSessionId, target: request.targetAgent, promise });
        void promise.finally(() => pending.delete(request.requestId)).catch(() => undefined);
        return promise;
    };
}

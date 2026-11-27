import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { portableNativeSourceIdentity, type PortableContextHead } from '@slopus/happy-wire';
import type { AgentState, Metadata } from '@/api/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { AsyncLock } from '@/utils/lock';

export type NativeConversationResume = { sourceSessionId: string; coverage: PortableContextHead[];
    contextEpoch?: { sessionId: string; boundaryId: string } | null; contextSources?: Array<{ sessionId: string; identity: string }> };
export type ConversationSessionLaunchRequest = {
    rootSessionId: string; sourceSessionId: string; requestId: string;
    targetAgent: NonNullable<SpawnSessionOptions['agent']>;
    codexSessionGrant?: string; expectedCodexAccountProfileId?: string | null;
    magpieModel?: string; traceId?: string;
};
export type ConversationSessionCancelRequest = Pick<ConversationSessionLaunchRequest, 'rootSessionId' | 'sourceSessionId' | 'requestId'>;
export type ConversationSessionCancelResult = { success: true; cancelled: true; targetSessionId?: string } | { success: false; error: string };
type ConversationMetadata = Metadata & {
    conversationRootSessionId?: string; conversationActiveSessionId?: string;
    continuationOfSessionId?: string;
    conversationSwitch?: { id: string; sourceSessionId: string; targetSessionId?: string };
    conversationDeletePlan?: unknown;
    portableContextBoundary?: { id: string; afterSeq: number };
};
export type ConversationLaunchSnapshot = {
    id: string; metadata: ConversationMetadata; seq: number; active: boolean;
    agentState: AgentState | null; agentStateVersion?: number;
};
export type ConversationNativeCandidate = {
    source: ConversationLaunchSnapshot; nativeId: string; owners: ConversationLaunchSnapshot[];
    coverage: PortableContextHead[];
    contextEpoch: { sessionId: string; boundaryId: string } | null;
    contextSources: Array<{ sessionId: string; identity: string }>;
};
type Success = Extract<SpawnSessionResult, { type: 'success' }> & { nativeResume?: NativeConversationResume };
type Receipt = { identity: string; phase: 'starting' | 'ready' | 'cancelled'; result?: Success; nativeResume?: NativeConversationResume; nativePlan?: 'fresh' | 'resume' };
type Validator = (() => Promise<void>) & { afterRetire: () => Promise<void> };
type Dependencies = {
    directory: string; machineId: string;
    read: (id: string) => Promise<ConversationLaunchSnapshot>;
    /** Live wrappers in the same native provider/path; not an ownership authority. */
    liveCandidates: (source: ConversationLaunchSnapshot) => string[];
    verifyNative: (candidate: ConversationLaunchSnapshot, request: ConversationSessionLaunchRequest) => Promise<boolean>;
    readCoverage: (owner: ConversationLaunchSnapshot) => Promise<PortableContextHead>;
    findCreated: (request: ConversationSessionLaunchRequest) => Promise<string | undefined>;
    spawn: (request: ConversationSessionLaunchRequest, source: ConversationLaunchSnapshot,
        native: ConversationNativeCandidate | undefined, validate: Validator) => Promise<SpawnSessionResult>;
    cancelTarget: (request: ConversationSessionCancelRequest, targetId: string, assertReservation: () => Promise<void>) => Promise<void>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const nativeId = (session: ConversationLaunchSnapshot) => session.metadata.flavor === 'claude'
    ? session.metadata.claudeSessionId : session.metadata.flavor === 'codex' ? session.metadata.codexThreadId : undefined;
const boundary = (session: ConversationLaunchSnapshot) => session.metadata.portableContextBoundary;
const identity = (request: ConversationSessionLaunchRequest) => JSON.stringify([
    request.rootSessionId, request.sourceSessionId, request.targetAgent,
    request.expectedCodexAccountProfileId ?? null, request.magpieModel ?? null,
]);
export function assertConversationLaunchIdle(session: ConversationLaunchSnapshot, options: { allowArchived?: boolean } = {}) {
    const { metadata, agentState: state } = session;
    if (metadata.application || metadata.sandbox?.enabled || metadata.conversationDeletePlan
        || (!options.allowArchived && ['archived', 'archiveRequested'].includes(metadata.lifecycleState ?? ''))
        || state?.controlledByUser === true || state?.claudeThinking === true
        || state?.turnStatus?.status === 'running' || (state?.queuedMessages ?? 0) > 0
        || Object.keys(state?.requests ?? {}).length > 0
        || (metadata.flavor === 'claude' && session.active && state?.claudeThinking !== false
            && state?.turnStatus?.status !== 'completed')) throw new Error('Wait for the conversation worker to finish before switching agents.');
}
function sameNative(a: ConversationLaunchSnapshot, b: ConversationLaunchSnapshot) {
    return a.metadata.flavor === b.metadata.flavor && nativeId(a) === nativeId(b)
        && a.metadata.codexAccountProfileId === b.metadata.codexAccountProfileId
        && a.metadata.codexMagpieConnection === b.metadata.codexMagpieConnection
        && a.metadata.claudeModelConnectionKey === b.metadata.claudeModelConnectionKey;
}
function revision(session: ConversationLaunchSnapshot) {
    const m = session.metadata;
    return JSON.stringify([session.id, session.seq, session.agentStateVersion, m.hostPid, m.lifecycleState,
        portableNativeSourceIdentity(m), m.conversationActiveSessionId, m.conversationSwitch, m.conversationDeletePlan]);
}
function bindingRevision(session: ConversationLaunchSnapshot) {
    const m = session.metadata;
    return JSON.stringify([session.id, portableNativeSourceIdentity(m), m.conversationActiveSessionId, m.conversationSwitch, m.conversationDeletePlan]);
}

/** A new App segment may reuse a verified native thread, never an old App segment. */
export function createConversationSessionLauncher(deps: Dependencies) {
    const roots = new Map<string, AsyncLock>();
    const pending = new Map<string, { identity: string; promise: Promise<SpawnSessionResult> }>();

    async function readChain(request: ConversationSessionLaunchRequest): Promise<ConversationLaunchSnapshot[]> {
        const root = await deps.read(request.rootSessionId);
        const rm = root.metadata;
        const reservation = rm.conversationSwitch;
        if (rm.machineId !== deps.machineId || !rm.path || rm.conversationDeletePlan
            || ['archived', 'archiveRequested'].includes(rm.lifecycleState ?? '')
            || (rm.conversationRootSessionId && rm.conversationRootSessionId !== root.id)
            || (rm.conversationActiveSessionId ?? root.id) !== request.sourceSessionId
            || reservation?.id !== request.requestId || reservation.sourceSessionId !== request.sourceSessionId
            || reservation.targetSessionId) throw new Error('The conversation switch reservation changed.');
        const chain: ConversationLaunchSnapshot[] = [];
        const seen = new Set<string>();
        let resetSeen = false;
        let id = request.sourceSessionId;
        for (let count = 0; count < 1000; count++) {
            if (seen.has(id)) throw new Error('The conversation predecessor chain is cyclic.');
            seen.add(id);
            const session = id === root.id ? root : await deps.read(id);
            const m = session.metadata;
            if (!resetSeen && m.forkedFromMessageId && !boundary(session)) throw new Error('The native fork boundary cannot be verified; start from a cleared conversation.');
            resetSeen ||= !!boundary(session);
            if (session.id !== id || m.machineId !== deps.machineId || m.path !== rm.path
                || (m.conversationRootSessionId && m.conversationRootSessionId !== root.id)
                || (id !== root.id && m.conversationActiveSessionId !== undefined)) throw new Error('The conversation predecessor chain cannot be verified.');
            chain.push(session);
            if (id === root.id) { assertConversationLaunchIdle(chain[0]); return chain; }
            if (!m.continuationOfSessionId) break;
            id = m.continuationOfSessionId;
        }
        throw new Error('The complete conversation predecessor chain is unavailable.');
    }

    async function selectNative(chain: ConversationLaunchSnapshot[], request: ConversationSessionLaunchRequest): Promise<ConversationNativeCandidate | undefined> {
        if (request.targetAgent !== 'claude' && request.targetAgent !== 'codex') return undefined;
        // A reset invalidates all older provider bindings. A post-reset native
        // identity in the reset's own segment remains eligible.
        const eligible: ConversationLaunchSnapshot[] = [];
        for (const session of chain) {
            eligible.push(session);
            if (boundary(session)) break;
        }
        for (const source of eligible) {
            const m = source.metadata;
            if (m.flavor !== request.targetAgent || m.capabilities?.conversationNativeResume !== 1
                || !uuid.test(nativeId(source) ?? '')) continue;
            if (request.targetAgent === 'codex'
                && ((m.codexAccountProfileId ?? null) !== (request.expectedCodexAccountProfileId ?? null)
                    || (m.codexMagpieConnection === true) !== !!request.magpieModel)) continue;
            try { assertConversationLaunchIdle(source); } catch { continue; }
            if (!await deps.verifyNative(source, request)) continue;
            const owners = eligible.filter(session => sameNative(source, session));
            for (const owner of owners) assertConversationLaunchIdle(owner);
            const owned = new Set(chain.map(session => session.id));
            // A lost webhook or an old metadata reader may hide a previous
            // pending reservation. Its durable native launch still owns that
            // identity until committed into this chain or positively cancelled.
            const files = await readdir(deps.directory).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw error;
            });
            for (const name of files) {
                if (!name.endsWith('.json') || name === `${request.requestId}.json`) continue;
                const previous = JSON.parse(await readFile(join(deps.directory, name), 'utf8')) as Receipt;
                const scope = JSON.parse(previous.identity) as unknown[];
                if (scope[0] !== request.rootSessionId || previous.phase === 'cancelled'
                    || (previous.result?.sessionId && owned.has(previous.result.sessionId))) continue;
                if (previous.nativePlan !== 'fresh' && (!previous.nativeResume
                    || owners.some(owner => owner.id === previous.nativeResume!.sourceSessionId))) return undefined;
            }
            for (const id of deps.liveCandidates(source)) {
                if (owned.has(id)) continue;
                const other = await deps.read(id);
                if (sameNative(other, source)) throw new Error('Another conversation still owns this native thread.');
                if (!nativeId(other) && other.metadata.crossAgentRequestId && owned.has(other.metadata.parentSessionId ?? '')) return undefined;
            }
            // Completed native-turn localIds prove a contiguous prefix. Queued,
            // cancelled, rejected or local-only inputs leave holes; never infer
            // their delivery from an idle flag or an archive descriptor.
            const coverage = await Promise.all(owners.map(session => deps.readCoverage(session)));
            const reset = eligible.find(session => boundary(session));
            return { source, nativeId: nativeId(source)!, owners, coverage,
                contextEpoch: reset ? { sessionId: reset.id, boundaryId: boundary(reset)!.id } : null,
                contextSources: eligible.map(session => ({ sessionId: session.id, identity: portableNativeSourceIdentity(session.metadata) })) };
        }
        return undefined;
    }

    async function perform(request: ConversationSessionLaunchRequest): Promise<SpawnSessionResult> {
        let mayHaveStarted = false;
        try {
        const path = join(deps.directory, `${request.requestId}.json`);
        let receipt: Receipt | undefined;
        try {
            const saved = await readFile(path, 'utf8');
            mayHaveStarted = true;
            receipt = JSON.parse(saved);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { mayHaveStarted = true; throw error; }
        }
        if (receipt) {
            mayHaveStarted = true;
            const saved = JSON.parse(receipt.identity);
            if (receipt.phase === 'cancelled' && saved[0] === request.rootSessionId && saved[1] === request.sourceSessionId) {
                return { type: 'error', notDispatched: true, conversationCancelled: true, errorMessage: 'This conversation launch was cancelled. Submit a new switch request.' };
            }
            if (receipt.identity !== identity(request)) throw new Error('Conversation launch request identity mismatch.');
            if (receipt.phase === 'ready' && receipt.result) return receipt.nativePlan === 'fresh' || receipt.result.nativeResume
                ? receipt.result : { ...receipt.result, nativeResume: { sourceSessionId: request.sourceSessionId, coverage: [] } };
            const recovered = await deps.findCreated(request);
            if (recovered) {
                // A recovered launch is safe to use without claiming incremental
                // coverage whose exact successful restore receipt was lost.
                const result: Success = { type: 'success', sessionId: recovered,
                    ...(receipt.nativeResume ? { nativeResume: { ...receipt.nativeResume, coverage: [] } }
                        : receipt.nativePlan !== 'fresh' ? { nativeResume: { sourceSessionId: request.sourceSessionId, coverage: [] } } : {}) };
                await writeFile(path, JSON.stringify({ ...receipt, phase: 'ready', result }), { mode: 0o600 });
                return result;
            }
            return { type: 'error', errorMessage: 'Conversation launch outcome is unknown. Retry the same switch after the worker registers; no prompt was replayed.' };
        }
        const chain = await readChain(request);
        const native = await selectNative(chain, request);
        const expected = chain.map(revision).join('\n');
        const validate = Object.assign(async () => {
            const current = await readChain(request);
            if (current.map(revision).join('\n') !== expected) throw new Error('The conversation changed while preparing its new worker.');
            if (native && !await deps.verifyNative(current.find(session => session.id === native.source.id)!, request)) throw new Error('The native agent connection changed.');
        }, { afterRetire: async () => {
            const current = await readChain(request);
            if (current.length !== chain.length || current.some((session, index) => {
                const previous = chain[index];
                const retired = native?.owners.some(owner => owner.id === session.id) && session.id !== request.sourceSessionId;
                return retired ? bindingRevision(session) !== bindingRevision(previous) : revision(session) !== revision(previous);
            })) throw new Error('The conversation changed while retiring the old native writer.');
        } });
        await validate();
        await mkdir(deps.directory, { recursive: true, mode: 0o700 });
        mayHaveStarted = true; // An existing exclusive receipt may own a worker.
        const file = await open(path, 'wx', 0o600);
        const nativeResume: NativeConversationResume | undefined = native ? { sourceSessionId: native.source.id,
            coverage: native.coverage, contextEpoch: native.contextEpoch, contextSources: native.contextSources } : undefined;
        const nativePlan = native ? 'resume' : 'fresh';
        try { await file.writeFile(JSON.stringify({ identity: identity(request), phase: 'starting', nativeResume, nativePlan })); await file.sync(); }
        finally { await file.close(); }
        const result = await deps.spawn(request, chain[0], native, validate);
        if (result.type === 'requestToApproveDirectoryCreation' || (result.type === 'error' && result.notDispatched)) await rm(path, { force: true });
        if (result.type !== 'success') return result;
        const ready: Success = { ...result, ...(nativeResume ? { nativeResume } : {}) };
        const temp = `${path}.tmp`;
        await writeFile(temp, JSON.stringify({ identity: identity(request), phase: 'ready', result: ready, nativePlan }), { mode: 0o600 });
        await rename(temp, path);
        return ready;
        } catch (error) {
            return { type: 'error', ...(!mayHaveStarted ? { notDispatched: true } : {}),
                errorMessage: error instanceof Error ? error.message : 'Conversation launch failed.' };
        }
    }

    const launch = (request: ConversationSessionLaunchRequest): Promise<SpawnSessionResult> => {
        if (!request || !uuid.test(request.requestId) || !request.rootSessionId || !request.sourceSessionId
            || !['claude', 'codex', 'opencode', 'antigravity'].includes(request.targetAgent)) {
            return Promise.resolve({ type: 'error', notDispatched: true, errorMessage: 'This agent does not support complete conversation context. Choose Claude, Codex, OpenCode, or Antigravity.' });
        }
        const existing = pending.get(request.requestId);
        if (existing) return existing.identity === identity(request) ? existing.promise
            : Promise.resolve({ type: 'error', notDispatched: true, errorMessage: 'Conversation launch request identity mismatch.' });
        const lock = roots.get(request.rootSessionId) ?? new AsyncLock(); roots.set(request.rootSessionId, lock);
        const promise = lock.inLock(() => perform(request)).catch(error => ({ type: 'error' as const, errorMessage: error instanceof Error ? error.message : 'Conversation launch failed.' }));
        pending.set(request.requestId, { identity: identity(request), promise });
        void promise.finally(() => pending.delete(request.requestId)).catch(() => undefined);
        return promise;
    };
    const cancel = (request: ConversationSessionCancelRequest): Promise<ConversationSessionCancelResult> => {
        if (!request || !uuid.test(request.requestId) || !request.rootSessionId || !request.sourceSessionId) return Promise.resolve({ success: false, error: 'Invalid conversation cancellation request.' });
        const lock = roots.get(request.rootSessionId) ?? new AsyncLock(); roots.set(request.rootSessionId, lock);
        return lock.inLock(async (): Promise<ConversationSessionCancelResult> => {
            const path = join(deps.directory, `${request.requestId}.json`);
            let receipt: Receipt | undefined;
            try { receipt = JSON.parse(await readFile(path, 'utf8')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const saved = receipt ? JSON.parse(receipt.identity) as unknown[] : undefined;
            if (saved && (saved[0] !== request.rootSessionId || saved[1] !== request.sourceSessionId)) throw new Error('Conversation cancellation identity mismatch.');
            if (receipt?.phase === 'cancelled') return { success: true, cancelled: true, ...(receipt.result?.sessionId ? { targetSessionId: receipt.result.sessionId } : {}) };
            let reservedTarget: string | undefined;
            const assertReservation = async () => {
                const root = await deps.read(request.rootSessionId);
                const metadata = root.metadata;
                const pending = metadata.conversationSwitch;
                if (metadata.machineId !== deps.machineId || !metadata.path || metadata.conversationDeletePlan
                    || (metadata.conversationRootSessionId && metadata.conversationRootSessionId !== root.id)
                    || (metadata.conversationActiveSessionId ?? root.id) !== request.sourceSessionId
                    || pending?.id !== request.requestId || pending.sourceSessionId !== request.sourceSessionId) throw new Error('The conversation cancellation reservation changed.');
                if (reservedTarget !== undefined && pending.targetSessionId !== undefined && pending.targetSessionId !== reservedTarget) throw new Error('The conversation cancellation target changed.');
                reservedTarget ??= pending.targetSessionId;
            };
            await assertReservation();
            if (!receipt) {
                if (reservedTarget) throw new Error('The conversation launch receipt is unavailable; its delivery remains unknown.');
                // No launch may dispatch without first owning this exclusive
                // receipt. A tombstone also rejects a delayed original RPC.
                await mkdir(deps.directory, { recursive: true, mode: 0o700 });
                const file = await open(path, 'wx', 0o600);
                try { await file.writeFile(JSON.stringify({ phase: 'cancelled', identity: JSON.stringify([request.rootSessionId, request.sourceSessionId]) })); await file.sync(); }
                finally { await file.close(); }
                return { success: true, cancelled: true };
            }
            const original: ConversationSessionLaunchRequest = { ...request, targetAgent: saved![2] as ConversationSessionLaunchRequest['targetAgent'] };
            const created = await deps.findCreated(original);
            const targetId = receipt.result?.sessionId ?? created;
            if (!targetId || (created && created !== targetId) || (reservedTarget && reservedTarget !== targetId)) throw new Error('The original conversation worker has not registered uniquely; its outcome remains unknown.');
            reservedTarget = targetId;
            await deps.cancelTarget(request, targetId, assertReservation);
            await assertReservation();
            const temp = `${path}.cancelled`;
            await writeFile(temp, JSON.stringify({ ...receipt, phase: 'cancelled', result: { type: 'success', sessionId: targetId } }), { mode: 0o600 });
            await rename(temp, path);
            return { success: true, cancelled: true, targetSessionId: targetId };
        }).catch(error => ({ success: false as const, error: error instanceof Error ? error.message : 'Cannot safely cancel the conversation launch.' }));
    };
    return Object.assign(launch, { cancel });
}

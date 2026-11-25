import { assertAccountRuntime } from '@/auth/accountRuntime';
import { t } from '@/text';
import { storage } from './storage';
import { sync } from './sync';
import { sessionUpdateMetadata } from './ops';
import type { Metadata, Session } from './storageTypes';

export type ConversationSwitch = { rootId: string; sourceId: string; targetId: string; requestId: string };
const unavailable = () => new Error(t('session.agentSwitchUnavailable'));
const changed = () => new Error(t('session.agentSwitchChanged'));

export function assertConversationSourceIdle(source: Session | undefined): asserts source is Session {
    if (!source?.metadata) throw unavailable();
    if (source.metadata.conversationDeletePlan || ['archived', 'archiveRequested'].includes(source.metadata.lifecycleState ?? '')) throw unavailable();
    if (source.thinking || source.hasPendingLocalMessages || source.agentState?.claudeThinking
        || source.agentState?.turnStatus?.status === 'running' || (source.agentState?.queuedMessages ?? 0) > 0
        || Object.keys(source.agentState?.requests ?? {}).length > 0) throw new Error(t('session.agentSwitchBusy'));
}

async function update(id: string, handler: (metadata: Metadata) => Metadata): Promise<void> {
    assertAccountRuntime();
    const source = storage.getState().sessions[id];
    if (!source?.metadata) throw unavailable();
    const result = await sessionUpdateMetadata(id, source.metadata, source.metadataVersion, metadata => {
        assertAccountRuntime();
        return handler(metadata);
    });
    assertAccountRuntime();
    const live = storage.getState().sessions[id];
    if (!live) throw unavailable();
    if (live.metadataVersion <= result.version) storage.getState().applySessions([{ ...live, metadata: result.metadata, metadataVersion: result.version }]);
}

/** A user-triggered fresh read; never treat a cached root as switch authority. */
export async function prepareConversationSwitch(sourceId: string): Promise<string> {
    if (!await sync.refreshConversationSession(sourceId)) throw unavailable();
    assertAccountRuntime();
    const source = storage.getState().sessions[sourceId];
    assertConversationSourceIdle(source);
    const rootId = source.metadata!.conversationRootSessionId ?? sourceId;
    if (rootId !== sourceId && !await sync.refreshConversationSession(rootId)) throw unavailable();
    assertAccountRuntime();
    const root = storage.getState().sessions[rootId];
    if (!root?.metadata || root.metadata.conversationDeletePlan) throw unavailable();
    if ((root.metadata.conversationActiveSessionId ?? rootId) !== sourceId) throw changed();
    if (root.metadata.conversationSwitch) throw new Error(t('session.agentSwitchPending'));
    return rootId;
}

export class ConversationSwitchClaimError extends Error {
    constructor(cause: unknown, public readonly candidateState: 'detached' | 'retained' | 'unknown') {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'ConversationSwitchClaimError';
        this.cause = cause;
    }
}

function isCandidateLinked(record: ConversationSwitch, metadata: Metadata | null | undefined): boolean {
    const root = storage.getState().sessions[record.rootId]?.metadata;
    return !!root && !root.conversationDeletePlan && (root.conversationActiveSessionId ?? record.rootId) === record.sourceId
        && !!metadata && metadata.conversationRootSessionId === record.rootId
        && metadata.continuationOfSessionId === record.sourceId
        && metadata.conversationActiveSessionId === undefined
        && (!root?.machineId || metadata.machineId === root.machineId)
        && (!root?.path || metadata.path === root.path);
}

/** A candidate becomes a conversation member only after its root reservation is known. */
async function linkReservedCandidate(record: ConversationSwitch): Promise<void> {
    await update(record.targetId, metadata => {
        const root = storage.getState().sessions[record.rootId]?.metadata;
        const pending = root?.conversationSwitch;
        if (!root || root.conversationDeletePlan || ['archived', 'archiveRequested'].includes(root.lifecycleState ?? '')) throw unavailable();
        if ((root.conversationActiveSessionId ?? record.rootId) !== record.sourceId
            || pending?.id !== record.requestId || pending.sourceSessionId !== record.sourceId
            || pending.targetSessionId !== record.targetId) throw changed();
        if (metadata.continuationOfSessionId !== record.sourceId || metadata.conversationActiveSessionId !== undefined
            || (metadata.conversationRootSessionId && metadata.conversationRootSessionId !== record.rootId)
            || (root.machineId && metadata.machineId !== root.machineId)
            || (root.path && metadata.path !== root.path)) throw changed();
        return metadata.conversationRootSessionId === record.rootId ? metadata : { ...metadata, conversationRootSessionId: record.rootId };
    });
}

/** A lost CAS acknowledgement is not proof that the reservation failed. */
async function reconcileFailedClaim(record: ConversationSwitch): Promise<'confirmed' | 'detached' | 'retained' | 'unknown'> {
    try {
        assertAccountRuntime();
        if (!await sync.refreshConversationSession(record.rootId)) return 'unknown';
        assertAccountRuntime();
        const root = storage.getState().sessions[record.rootId]?.metadata;
        if (!root) return 'unknown';
        const pending = root.conversationSwitch;
        if (pending?.id === record.requestId && pending.sourceSessionId === record.sourceId
            && pending.targetSessionId === record.targetId) {
            // Root acknowledgement alone does not prove that candidate linkage completed.
            try {
                if (!await sync.refreshConversationSession(record.targetId)) return 'retained';
                assertAccountRuntime();
                return isCandidateLinked(record, storage.getState().sessions[record.targetId]?.metadata) ? 'confirmed' : 'retained';
            } catch { return 'retained'; }
        }
        if ((root.conversationActiveSessionId ?? record.rootId) === record.targetId
            || pending?.targetSessionId === record.targetId) return 'retained';
        if (!await sync.refreshConversationSession(record.targetId)) return 'unknown';
        assertAccountRuntime();
        const target = storage.getState().sessions[record.targetId];
        if (!target?.metadata) return 'unknown';
        let retained = false;
        await update(record.targetId, metadata => {
            // Retry callbacks must also respect a newer root event or candidate owner.
            const liveRoot = storage.getState().sessions[record.rootId]?.metadata;
            if (!liveRoot || (liveRoot.conversationActiveSessionId ?? record.rootId) === record.targetId
                || liveRoot.conversationSwitch?.targetSessionId === record.targetId) {
                retained = true;
                return metadata;
            }
            if (metadata.conversationRootSessionId !== record.rootId) return metadata;
            if (metadata.conversationActiveSessionId || metadata.continuationOfSessionId !== record.sourceId) {
                retained = true;
                return metadata;
            }
            const { conversationRootSessionId: _root, ...rest } = metadata;
            return rest;
        });
        return retained ? 'retained' : 'detached';
    } catch {
        // Preserve candidate membership if authority or rollback cannot be confirmed.
        return 'unknown';
    }
}

/** CAS-reserve the root before linking a candidate or sending any prompt. */
export async function claimConversationSwitch(record: ConversationSwitch): Promise<void> {
    assertConversationSourceIdle(storage.getState().sessions[record.sourceId]);
    try {
        await update(record.rootId, metadata => {
            if (metadata.conversationDeletePlan || ['archived', 'archiveRequested'].includes(metadata.lifecycleState ?? '')) throw unavailable();
            if ((metadata.conversationActiveSessionId ?? record.rootId) !== record.sourceId) throw changed();
            const pending = metadata.conversationSwitch;
            if (pending) {
                if (pending.id === record.requestId && pending.sourceSessionId === record.sourceId && pending.targetSessionId === record.targetId) return metadata;
                throw new Error(t('session.agentSwitchPending'));
            }
            return { ...metadata, conversationSwitch: { id: record.requestId, sourceSessionId: record.sourceId, targetSessionId: record.targetId } };
        });
        await linkReservedCandidate(record);
    } catch (cause) {
        const outcome = await reconcileFailedClaim(record);
        if (outcome === 'confirmed') return;
        throw new ConversationSwitchClaimError(cause, outcome);
    }
}

/** Publish only after the first prompt has a confirmed server delivery receipt. */
export async function commitConversationSwitch(record: ConversationSwitch): Promise<void> {
    await update(record.rootId, metadata => {
        if (metadata.conversationActiveSessionId === record.targetId && !metadata.conversationSwitch) return metadata;
        const pending = metadata.conversationSwitch;
        if ((metadata.conversationActiveSessionId ?? record.rootId) !== record.sourceId
            || pending?.id !== record.requestId || pending.sourceSessionId !== record.sourceId
            || pending.targetSessionId !== record.targetId) throw changed();
        const { conversationSwitch: _pending, ...rest } = metadata;
        return { ...rest, conversationActiveSessionId: record.targetId };
    });
}

/** Only the creator may release a claim it knows has never attempted delivery. */
export async function releaseConversationSwitch(record: ConversationSwitch): Promise<void> {
    await update(record.rootId, metadata => {
        const pending = metadata.conversationSwitch;
        if (!pending || pending.id !== record.requestId) return metadata;
        if (pending.targetSessionId !== record.targetId
            || (metadata.conversationActiveSessionId ?? record.rootId) !== record.sourceId) throw changed();
        const { conversationSwitch: _pending, ...rest } = metadata;
        return rest;
    });
    // Released, unsent candidates remain independent continuations rather than
    // invisible conversation members outside the committed execution chain.
    await reconcileFailedClaim(record);
}

/** A reload can finish an acknowledged handoff, but never replays an uncertain prompt. */
export async function recoverConversationSwitch(rootId: string): Promise<boolean> {
    if (!await sync.refreshConversationSession(rootId)) throw unavailable();
    assertAccountRuntime();
    const pending = storage.getState().sessions[rootId]?.metadata?.conversationSwitch;
    if (!pending?.targetSessionId) return false;
    if (!await sync.ensureSessionHydrated(pending.sourceSessionId)
        || !await sync.refreshConversationSession(pending.targetSessionId)) throw unavailable();
    assertAccountRuntime();
    const source = storage.getState().sessions[pending.sourceSessionId];
    if (!source?.metadata || (pending.sourceSessionId !== rootId && source.metadata.conversationRootSessionId !== rootId)) throw changed();
    const record = { rootId, sourceId: pending.sourceSessionId, targetId: pending.targetSessionId, requestId: pending.id };
    // A root reservation may have survived a lost ACK before target linkage.
    // Repair only its verified predecessor/ownership; never replay a prompt.
    await linkReservedCandidate(record);
    if (!await sync.hasConversationHandoffDelivery(pending.targetSessionId, pending.sourceSessionId)) throw new Error(t('session.agentSwitchPending'));
    await commitConversationSwitch(record);
    return true;
}

/** Called again immediately before outbox commit, after any attachment uploads. */
export function assertConversationSendAllowed(sessionId: string, requestId?: string): void {
    const sessions = storage.getState().sessions;
    const session = sessions[sessionId];
    if (!session?.metadata) return; // Ordinary send retains its existing availability checks.
    // A reserved-but-unlinked candidate is not an independent send destination.
    const reservation = Object.values(sessions).find(candidate => candidate.metadata?.conversationSwitch?.targetSessionId === sessionId);
    const rootId = session.metadata.conversationRootSessionId ?? reservation?.id ?? sessionId;
    if (reservation && reservation.id !== rootId) throw changed();
    const root = sessions[rootId];
    if (!root?.metadata) throw unavailable();
    if (root.metadata.conversationDeletePlan) throw unavailable();
    const pending = root.metadata.conversationSwitch;
    if (pending) {
        if (requestId === pending.id && pending.targetSessionId === sessionId
            && (root.metadata.conversationActiveSessionId ?? rootId) === pending.sourceSessionId
            && session.metadata.conversationRootSessionId === rootId
            && session.metadata.continuationOfSessionId === pending.sourceSessionId) return;
        throw new Error(t('session.agentSwitchPending'));
    }
    if ((root.metadata.conversationActiveSessionId ?? rootId) !== sessionId) throw changed();
}

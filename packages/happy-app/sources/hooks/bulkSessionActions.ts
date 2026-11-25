import { sessionArchive, sessionDelete, sessionKill, sessionRequestArchiveMetadata, sessionUpdateMetadata } from '@/sync/ops';
import { sync } from '@/sync/sync';
import type { Metadata, Session } from '@/sync/storageTypes';
import { assertAccountRuntime } from '@/auth/accountRuntime';
import { storage } from '@/sync/storage';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { getConversationRootSessionId, getConversationSessionChain, resolveConversationRootSessionId, resolveConversationSessionId } from '@/sync/conversationSession';
import { t } from '@/text';

const actionUnavailable = () => new Error(t('session.conversationActionUnavailable'));
const sameLocation = (a: Session, b: Session) => a.metadata?.machineId === b.metadata?.machineId && a.metadata?.path === b.metadata?.path;

/** A user-triggered authority read. Missing legacy membership is never standalone authority. */
export async function refreshConversationActionAuthority(requested: Session, options: {
    allowDeletePlan?: boolean;
    expectedRootId?: string | null;
} = {}): Promise<{ source: Session; root: Session; current: Session | null; grouped: boolean }> {
    const before = storage.getState().sessions;
    const expectedRootId = options.expectedRootId !== undefined ? options.expectedRootId
        : requested.metadata?.conversationRootSessionId ?? resolveConversationRootSessionId(before, requested.id);
    const refreshed = new Set<string>();
    const fresh = async (id: string): Promise<Session> => {
        if (!refreshed.has(id)) {
            if (!storage.getState().sessions[id] && !await ensureSessionHydratedWithRetry(id)) throw actionUnavailable();
            if (!await sync.refreshConversationSession(id)) throw actionUnavailable();
            assertAccountRuntime();
            refreshed.add(id);
        }
        const value = storage.getState().sessions[id];
        if (!value || value.id !== id) throw actionUnavailable();
        return value;
    };
    const source = await fresh(requested.id);
    if (source.metadata?.conversationRootSessionId && expectedRootId
        && source.metadata.conversationRootSessionId !== expectedRootId) throw new Error(t('session.agentSwitchChanged'));
    const inferred = resolveConversationRootSessionId(storage.getState().sessions, source.id);
    const planRoots = Object.values(storage.getState().sessions).filter(candidate =>
        candidate.metadata?.conversationDeletePlan?.sessionIds.includes(source.id));
    if (planRoots.length > 1) throw actionUnavailable();
    let candidateId: string | null = source.metadata?.conversationRootSessionId
        ?? (inferred && inferred !== source.id ? inferred : null)
        ?? planRoots[0]?.id
        ?? (source.metadata?.conversationActiveSessionId || source.metadata?.conversationSwitch ? source.id : null);
    // A legacy child still retains continuationOfSessionId. Follow distinct
    // predecessors only to discover an authority; this never polls status.
    let ancestor = source;
    const ancestors = new Set([source.id]);
    for (let count = 0; !candidateId && ancestor.metadata?.continuationOfSessionId; count++) {
        const previousId = ancestor.metadata.continuationOfSessionId;
        if (count >= 1000 || ancestors.has(previousId)) throw actionUnavailable();
        ancestors.add(previousId);
        // A separately created continuation does not own its predecessor.
        // With no root claim, a deleted predecessor must not prevent its cleanup.
        if (!storage.getState().sessions[previousId] && inferred === source.id
            && !source.metadata?.conversationRootSessionId && planRoots.length === 0) break;
        const previous = await fresh(previousId);
        if (!sameLocation(source, previous)) break;
        candidateId = previous.metadata?.conversationRootSessionId
            ?? (previous.metadata?.conversationActiveSessionId || previous.metadata?.conversationSwitch || previous.metadata?.conversationDeletePlan ? previous.id : null);
        ancestor = previous;
    }
    const candidate = await fresh(candidateId ?? source.id);
    if (getConversationRootSessionId(candidate) !== candidate.id || !sameLocation(candidate, source)) throw actionUnavailable();
    if (candidate.metadata?.conversationSwitch) throw new Error(t('session.agentSwitchPending'));
    const savedPlan = candidate.metadata?.conversationDeletePlan;
    if (savedPlan) {
        if (!options.allowDeletePlan) throw new Error(t('session.conversationDeletePending'));
        if (!savedPlan.sessionIds.includes(source.id) || expectedRootId && candidate.id !== expectedRootId) throw actionUnavailable();
        return { source, root: candidate, current: null, grouped: true };
    }
    const activeId = candidate.metadata?.conversationActiveSessionId ?? candidate.id;
    let id = activeId;
    const seen = new Set<string>();
    for (let count = 0; ; count++) {
        if (count >= 1000 || seen.has(id)) throw actionUnavailable();
        seen.add(id);
        const segment = await fresh(id);
        if (!sameLocation(candidate, segment)) throw actionUnavailable();
        if (id === candidate.id) break;
        if (segment.metadata?.conversationRootSessionId && segment.metadata.conversationRootSessionId !== candidate.id
            || segment.metadata?.conversationActiveSessionId !== undefined || !segment.metadata?.continuationOfSessionId) throw actionUnavailable();
        id = segment.metadata.continuationOfSessionId;
    }
    const sessions = storage.getState().sessions;
    const liveRoot = sessions[candidate.id];
    if ((liveRoot?.metadata?.conversationActiveSessionId ?? candidate.id) !== activeId
        || liveRoot?.metadata?.conversationSwitch || liveRoot?.metadata?.conversationDeletePlan) throw actionUnavailable();
    const rootId = resolveConversationRootSessionId(sessions, source.id);
    const currentId = resolveConversationSessionId(sessions, source.id);
    if (!rootId || !currentId || !refreshed.has(rootId) || expectedRootId && rootId !== expectedRootId) throw actionUnavailable();
    const root = sessions[rootId];
    return { source, root, current: sessions[currentId], grouped: rootId !== source.id || Boolean(root.metadata?.conversationActiveSessionId) };
}

/** Validate every segment before a destructive action so a missing target cannot delete only the root. */
export async function resolveSessionsForBulkAction(selected: Session[]): Promise<Session[]> {
    const result = new Map<string, Session>();
    const roots = new Set<string>();
    for (const requestedSession of selected) {
        const authority = await refreshConversationActionAuthority(requestedSession);
        if (!authority.grouped) {
            result.set(authority.source.id, authority.source);
            continue;
        }
        const rootId = authority.root.id;
        if (roots.has(rootId)) continue;
        const activeId = authority.current!.id;
        const latest = storage.getState().sessions;
        const chain = getConversationSessionChain(latest, rootId);
        if (!chain) throw new Error(t('session.conversationActionUnavailable'));
        // Retain the active worker and stable root if an earlier segment fails.
        const historical = chain.filter(segmentId => segmentId !== activeId && segmentId !== rootId).reverse();
        [...historical, ...(activeId !== rootId ? [activeId] : []), rootId]
            .forEach(segmentId => result.set(segmentId, latest[segmentId]));
        roots.add(rootId);
    }
    return [...result.values()];
}

type DeletePlan = NonNullable<Metadata['conversationDeletePlan']>;
type DeleteBatch = { sessionIds: string[]; rootId?: string; plan?: DeletePlan };

function sameDeletePlan(a: DeletePlan, b: DeletePlan): boolean {
    return a.activeSessionId === b.activeSessionId && JSON.stringify(a.sessionIds) === JSON.stringify(b.sessionIds);
}

function validateDeletePlan(root: Session, plan: DeletePlan): void {
    const ids = plan.sessionIds;
    if (!root.metadata?.machineId || !root.metadata.path || getConversationRootSessionId(root) !== root.id || root.metadata.conversationSwitch
        || !Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length
        || ids.at(-1) !== root.id || !ids.includes(plan.activeSessionId)
        || (ids.length > 1 ? ids.at(-2) !== plan.activeSessionId : plan.activeSessionId !== root.id)
        || (root.metadata.conversationActiveSessionId ?? root.id) !== plan.activeSessionId
        || !Array.isArray(plan.completedSessionIds) || new Set(plan.completedSessionIds).size !== plan.completedSessionIds.length
        || plan.completedSessionIds.some(id => !ids.includes(id) || id === root.id)) {
        throw new Error(t('session.conversationDeletePlanInvalid'));
    }
    // Existing objects must still belong to this exact chat. Missing objects are
    // retryable only because their IDs were saved in this validated plan.
    const sessions = storage.getState().sessions;
    for (const [index, id] of ids.entries()) {
        const segment = sessions[id];
        if (!segment || id === root.id) continue;
        const expectedPrevious = index === 0 ? root.id : ids[index - 1];
        if (segment.metadata?.conversationRootSessionId && segment.metadata.conversationRootSessionId !== root.id
            || segment.metadata?.conversationActiveSessionId !== undefined
            || segment.metadata?.continuationOfSessionId !== expectedPrevious
            || segment.metadata?.machineId !== root.metadata.machineId || segment.metadata?.path !== root.metadata.path) {
            throw new Error(t('session.conversationDeletePlanInvalid'));
        }
    }
}

async function writeDeletePlan(rootId: string, proposed: DeletePlan, completedId?: string): Promise<DeletePlan> {
    assertAccountRuntime();
    const root = storage.getState().sessions[rootId];
    if (!root?.metadata) throw new Error(t('session.conversationDeleteStateUnavailable'));
    validateDeletePlan(root, proposed);
    const result = await sessionUpdateMetadata(rootId, root.metadata, root.metadataVersion, metadata => {
        assertAccountRuntime();
        const current = metadata.conversationDeletePlan;
        if ((metadata.conversationActiveSessionId ?? rootId) !== proposed.activeSessionId || metadata.conversationSwitch
            || current && !sameDeletePlan(current, proposed)) throw new Error(t('session.conversationDeleteStateChanged'));
        if (current) validateDeletePlan({ ...root, metadata }, current);
        if (completedId && !current) throw new Error(t('session.conversationDeleteReceiptFailed'));
        const completed = new Set(current?.completedSessionIds ?? proposed.completedSessionIds);
        if (completedId) completed.add(completedId);
        return { ...metadata, conversationDeletePlan: { ...proposed, completedSessionIds: proposed.sessionIds.filter(id => completed.has(id)) } };
    });
    assertAccountRuntime();
    const live = storage.getState().sessions[rootId];
    if (!live) throw new Error(t('session.conversationDeleteStateUnavailable'));
    if (live.metadataVersion <= result.version) storage.getState().applySessions([{ ...live, metadata: result.metadata, metadataVersion: result.version }]);
    const saved = storage.getState().sessions[rootId];
    if (!saved?.metadata?.conversationDeletePlan || !sameDeletePlan(saved.metadata.conversationDeletePlan, proposed)) {
        throw new Error(t('session.conversationDeleteReceiptFailed'));
    }
    validateDeletePlan(saved, saved.metadata.conversationDeletePlan);
    return saved.metadata.conversationDeletePlan;
}

async function prepareDeleteBatches(selected: Session[]): Promise<DeleteBatch[]> {
    const batches: DeleteBatch[] = [];
    const represented = new Set<string>();
    for (const requested of selected) {
        assertAccountRuntime();
        const authority = await refreshConversationActionAuthority(requested, { allowDeletePlan: true });
        const session = authority.source;
        const rootId = authority.root.id;
        if (represented.has(rootId)) continue;
        represented.add(rootId);
        if (!authority.grouped) { batches.push({ sessionIds: [session.id] }); continue; }
        let root = authority.root;
        if (!root?.metadata) throw new Error(t('session.conversationDeleteStateUnavailable'));
        let plan = root.metadata.conversationDeletePlan;
        if (!plan) {
            const chain = await resolveSessionsForBulkAction([root]);
            root = storage.getState().sessions[rootId];
            plan = { sessionIds: chain.map(segment => segment.id), completedSessionIds: [], activeSessionId: root.metadata?.conversationActiveSessionId ?? root.id };
            plan = await writeDeletePlan(rootId, plan);
        }
        validateDeletePlan(storage.getState().sessions[rootId], plan);
        batches.push({ rootId, plan, sessionIds: plan.sessionIds.filter(id => !plan!.completedSessionIds.includes(id)) });
    }
    return batches;
}

export class BulkSessionActionError extends Error {
    constructor(
        action: 'archive' | 'delete',
        public readonly completedIds: string[],
        public readonly failedSessionId: string,
        public readonly pendingIds: string[],
        cause: unknown,
    ) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(t(action === 'delete' ? 'session.conversationDeletePartial' : 'session.conversationArchivePartial', {
            completed: completedIds.length, remaining: pendingIds.length + 1, detail,
        }));
        this.name = 'BulkSessionActionError';
    }
}

export async function bulkArchiveSessions(sessions: Session[]): Promise<void> {
    const planned = await resolveSessionsForBulkAction(sessions);
    const completedIds: string[] = [];
    for (const [index, session] of planned.entries()) {
        try {
            await sessionRequestArchiveMetadata(session);
            const killResult = session.presence === 'online' && Boolean(session.metadata?.machineId)
                ? await sessionKill(session.id) : { success: false };
            if (!killResult.success) {
                const archiveResult = await sessionArchive(session.id);
                if (!archiveResult.success) {
                    throw new Error(archiveResult.message || t('sessionInfo.failedToArchiveSession'));
                }
            }
            completedIds.push(session.id);
        } catch (error) {
            throw new BulkSessionActionError('archive', completedIds, session.id, planned.slice(index + 1).map(next => next.id), error);
        }
    }
}

export async function bulkDeleteSessions(sessions: Session[]): Promise<void> {
    const batches = await prepareDeleteBatches(sessions);
    const completedIds: string[] = [];
    const pendingIds = batches.flatMap(batch => batch.sessionIds);
    for (const batch of batches) {
        completedIds.push(...batch.plan?.completedSessionIds ?? []);
        for (const id of batch.sessionIds) {
            try {
                assertAccountRuntime();
                const session = storage.getState().sessions[id] ?? sessions.find(candidate => candidate.id === id);
                if (session?.active || session?.presence === 'online') await sessionKill(id).catch(() => {});
                const deleteResult = await sessionDelete(id);
                if (!deleteResult.success) throw new Error(deleteResult.message || t('sessionInfo.failedToDeleteSession'));
                sync.removeSessionLocally(id);
                completedIds.push(id);
                pendingIds.splice(pendingIds.indexOf(id), 1);
                if (batch.rootId && batch.plan && id !== batch.rootId) batch.plan = await writeDeletePlan(batch.rootId, batch.plan, id);
            } catch (error) {
                throw new BulkSessionActionError('delete', [...completedIds], id, pendingIds.filter(pending => pending !== id), error);
            }
        }
    }
}

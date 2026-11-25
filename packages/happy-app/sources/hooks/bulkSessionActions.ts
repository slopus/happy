import { sessionArchive, sessionDelete, sessionKill, sessionRequestArchiveMetadata, sessionUpdateMetadata } from '@/sync/ops';
import { sync } from '@/sync/sync';
import type { Metadata, Session } from '@/sync/storageTypes';
import { assertAccountRuntime } from '@/auth/accountRuntime';
import { storage } from '@/sync/storage';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { getConversationRootSessionId, getConversationSessionChain } from '@/sync/conversationSession';
import { t } from '@/text';

/** Validate every segment before a destructive action so a missing target cannot delete only the root. */
export async function resolveSessionsForBulkAction(selected: Session[]): Promise<Session[]> {
    const result = new Map<string, Session>();
    const roots = new Set<string>();
    for (const requestedSession of selected) {
        if (!await sync.refreshConversationSession(requestedSession.id)) throw new Error(t('session.conversationActionUnavailable'));
        assertAccountRuntime();
        const selectedSession = storage.getState().sessions[requestedSession.id];
        if (!selectedSession) throw new Error(t('session.conversationActionUnavailable'));
        if (!selectedSession.metadata?.conversationRootSessionId && !selectedSession.metadata?.conversationActiveSessionId
            && !selectedSession.metadata?.conversationSwitch && !selectedSession.metadata?.conversationDeletePlan) {
            result.set(selectedSession.id, selectedSession);
            continue;
        }
        const rootId = getConversationRootSessionId(selectedSession);
        if (roots.has(rootId)) continue;
        if (!await sync.refreshConversationSession(rootId)) throw new Error(t('session.conversationActionUnavailable'));
        const root = storage.getState().sessions[rootId];
        if (!root?.metadata) throw new Error(t('session.conversationActionUnavailable'));
        if (root.metadata.conversationDeletePlan) throw new Error(t('session.conversationDeletePending'));
        const activeId = root.metadata.conversationActiveSessionId ?? root.id;
        const pending = root.metadata.conversationSwitch;
        if (pending) throw new Error(t('session.agentSwitchPending'));
        let id = activeId;
        const seen = new Set<string>();
        let complete = false;
        // Each iteration follows a different stored predecessor; this is bounded history loading, not status polling.
        for (let count = 0; count < 1000; count++) {
            if (seen.has(id) || !await ensureSessionHydratedWithRetry(id)) break;
            seen.add(id);
            const segment = storage.getState().sessions[id];
            if (!segment) break;
            if (id === rootId) { complete = true; break; }
            if (segment.metadata?.conversationRootSessionId !== rootId || !segment.metadata.continuationOfSessionId) break;
            id = segment.metadata.continuationOfSessionId;
        }
        const latest = storage.getState().sessions;
        const currentRoot = latest[rootId];
        if (!complete || currentRoot?.metadata?.conversationActiveSessionId !== root.metadata.conversationActiveSessionId
            || currentRoot?.metadata?.conversationSwitch !== undefined || currentRoot?.metadata?.conversationDeletePlan !== undefined) {
            throw new Error(t('session.conversationActionUnavailable'));
        }
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
    if (!root.metadata || getConversationRootSessionId(root) !== root.id || root.metadata.conversationSwitch
        || !Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length
        || ids.at(-1) !== root.id || !ids.includes(plan.activeSessionId)
        || (root.metadata.conversationActiveSessionId ?? root.id) !== plan.activeSessionId
        || !Array.isArray(plan.completedSessionIds) || new Set(plan.completedSessionIds).size !== plan.completedSessionIds.length
        || plan.completedSessionIds.some(id => !ids.includes(id) || id === root.id)) {
        throw new Error(t('session.conversationDeletePlanInvalid'));
    }
    // Existing objects must still belong to this exact chat. Missing objects are
    // retryable only because their IDs were saved in this validated plan.
    const sessions = storage.getState().sessions;
    for (const id of ids) {
        const segment = sessions[id];
        if (!segment || id === root.id) continue;
        if (segment.metadata?.conversationRootSessionId !== root.id
            || segment.metadata.machineId !== root.metadata.machineId || segment.metadata.path !== root.metadata.path) {
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
        if (!await sync.refreshConversationSession(requested.id)) throw new Error(t('session.conversationDeleteStateUnavailable'));
        assertAccountRuntime();
        const session = storage.getState().sessions[requested.id];
        if (!session) throw new Error(t('session.conversationDeleteStateUnavailable'));
        const isConversation = !!(session.metadata?.conversationRootSessionId || session.metadata?.conversationActiveSessionId
            || session.metadata?.conversationSwitch || session.metadata?.conversationDeletePlan);
        const rootId = isConversation ? getConversationRootSessionId(session) : session.id;
        if (represented.has(rootId)) continue;
        represented.add(rootId);
        if (!isConversation) { batches.push({ sessionIds: [session.id] }); continue; }
        if (!await sync.refreshConversationSession(rootId)) throw new Error(t('session.conversationDeleteStateUnavailable'));
        assertAccountRuntime();
        let root = storage.getState().sessions[rootId];
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

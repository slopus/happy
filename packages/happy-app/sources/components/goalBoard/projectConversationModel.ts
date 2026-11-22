import type { GoalTaskSession } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';
import { buildSessionActivity } from '../sessionActivity/sessionActivity';
import { resolveSessionState } from '@/utils/sessionUtils';
import { isProjectConversationArchived } from '@/sync/projectConversationLifecycle';
import { isRetiredSession } from '@/sync/retiredSessions';
import { isArchivedLifecycleState } from '@/utils/sessionLifecycle';
export type Conversation = GoalTaskSession & { taskId?: string };
export type ConversationGroup = {
    scopePath: string;
    title: string;
    total: number;
    sessions: Conversation[];
    nextCursor?: { updatedAt: number; sessionId: string };
};
export type ConversationStatus = 'attention' | 'failed' | 'unread' | 'running' | 'unknown' | 'completed' | 'idle' | 'history';
export type ConversationRow = Conversation & { status: ConversationStatus };
const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
function ownerMatches(session: Session, machineId: string, scopePath: string, row?: Conversation) {
    const m = session.metadata;
    if (!m || m.machineId !== machineId) return false;
    if (row?.taskId && /^GFT-[a-z0-9]{8}$/.test(row.taskId) && m.goalBoard?.taskId === row.taskId) return true;
    if (m.goalBoard) return normal(m.goalBoard.featurePath) === normal(scopePath) && (!row || m.goalBoard.taskId === row.taskId);
    return row ? normal(m.path) === normal(row.directory) : normal(m.path) === normal(scopePath);
}
/** History supplies complete totals; only actual headers supply live status. */
export function buildProjectConversationGroups(
    groups: ConversationGroup[],
    headers: Record<string, Session>,
    unread: ReadonlySet<string>,
    connected: boolean,
    machineId: string,
    deleted: ReadonlySet<string>,
) {
    const authoritative = new Set(groups.flatMap((group) => group.sessions.map((row) => row.sessionId)));
    const knownHeaders = Object.values(headers);
    const activity = new Map(buildSessionActivity(knownHeaders, unread, connected).map((row) => [row.session.id, row]));
    return groups.map((group) => {
        let removed = 0;
        const rows = new Map<string, Conversation>();
        for (const row of group.sessions) {
            const live = headers[row.sessionId];
            if (
                deleted.has(row.sessionId) ||
                isProjectConversationArchived(row, live) ||
                (live && (isRetiredSession(live) || !ownerMatches(live, machineId, group.scopePath, row)))
            ) {
                removed++;
                continue;
            }
            rows.set(row.sessionId, row);
        }
        // Unbound scope work has an exact directory owner. Task membership must
        // come from RPC: stale or duplicate task metadata is not authorization.
        for (const s of knownHeaders) {
            const id = s.id;
            if (!s.metadata?.goalBoard?.taskId && !isRetiredSession(s) && !isArchivedLifecycleState(s.metadata?.lifecycleState) &&
                !authoritative.has(id) && !rows.has(id) && !deleted.has(id) && ownerMatches(s, machineId, group.scopePath)) {
                rows.set(id, {
                    sessionId: id,
                    taskId: s.metadata?.goalBoard?.taskId,
                    title: s.metadata?.name || s.metadata?.summary?.text || '',
                    directory: s.metadata!.path,
                    updatedAt: s.updatedAt,
                    executed: (s.seq ?? 0) > 1,
                });
            }
        }
        return {
            ...group,
            total: Math.max(rows.size, group.total - removed),
            rows: [...rows.values()]
                .map((row) => {
                    const live = headers[row.sessionId],
                        a = activity.get(row.sessionId);
                    const resolved = live ? resolveSessionState(live).state : undefined;
                    const status: ConversationStatus = a
                        ? a.category === 'attention'
                            ? a.state === 'failed'
                                ? 'failed'
                                : 'attention'
                            : a.category
                        : resolved
                          ? resolved === 'permission_required'
                              ? 'attention'
                              : resolved
                          : 'history';
                    return {
                        ...row,
                        title: live?.metadata?.name || live?.metadata?.summary?.text || row.title,
                        updatedAt: Math.max(row.updatedAt, live?.updatedAt ?? 0),
                        status,
                    };
                })
                .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId)),
        };
    });
}

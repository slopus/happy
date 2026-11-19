import type { Session } from '@/sync/storageTypes';
import { resolveSessionState } from '@/utils/sessionUtils';
import { isArchivedLifecycleState } from '@/utils/sessionLifecycle';
import { isRetiredSession } from '@/sync/retiredSessions';

export type ActivityCategory = 'attention' | 'running' | 'unread' | 'unknown';
export type ActivityScope = { machineId: string; path: string; title: string; taskId?: string; directory?: string };
export type SessionActivity = { session: Session; category: ActivityCategory; state: ReturnType<typeof resolveSessionState>['state']; connected: boolean };
export const activityCategories: ActivityCategory[] = ['attention', 'running', 'unread', 'unknown'];

/** Account-scoped headers only: no history scanning, side effects or status timers. */
export function buildSessionActivity(sessions: Session[], unread: ReadonlySet<string>, transportConnected: boolean): SessionActivity[] {
    const rows: SessionActivity[] = [];
    for (const session of new Map(sessions.map(session => [session.id, session])).values()) {
        if (isRetiredSession(session) || isArchivedLifecycleState(session.metadata?.lifecycleState)) continue;
        const resolved = resolveSessionState(session);
        const connected = transportConnected && resolved.isConnected;
        const unfinished = session.thinking || session.agentState?.turnStatus?.status === 'running' || (session.agentState?.queuedMessages ?? 0) > 0;
        const category: ActivityCategory | undefined = resolved.state === 'permission_required' || resolved.state === 'failed' ? 'attention'
            : unfinished ? connected ? 'running' : 'unknown'
            : unread.has(session.id) ? 'unread' : undefined;
        if (category) rows.push({ session, category, state: resolved.state, connected });
    }
    return rows.sort((a, b) => b.session.updatedAt - a.session.updatedAt || a.session.id.localeCompare(b.session.id));
}
export function countSessionActivity(rows: SessionActivity[]): Record<ActivityCategory, number> {
    const counts = { attention: 0, running: 0, unread: 0, unknown: 0 };
    for (const row of rows) counts[row.category]++;
    return counts;
}
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
export function matchesActivityScope({ session }: Pick<SessionActivity, 'session'>, scope: ActivityScope): boolean {
    const metadata = session.metadata;
    if (!metadata || metadata.machineId !== scope.machineId) return false;
    const owner = metadata.goalBoard;
    if (scope.taskId) {
        if (owner) return normalize(owner.featurePath) === normalize(scope.path) && owner.taskId === scope.taskId;
        return !!scope.directory && normalize(metadata.path) === normalize(scope.directory);
    }
    const path = normalize(owner?.featurePath ?? metadata.path), root = normalize(scope.path);
    return path === root || path.startsWith(`${root}/`);
}

import type { DelegatedTaskSummary } from '@slopus/happy-wire';
import type { Metadata } from '@/sync/storageTypes';
import type { ScopedTranscriptItem } from './continuationTranscript';

/** Attach metadata-only tasks to existing reading rows, without changing message
 * identities or inventing provider messages. Native wrappers can contain several
 * MCP calls, so an individual delegate_task tool row is not always available. */
export function anchorDelegatedTasks(items: ScopedTranscriptItem[], options: {
    sessionId?: string;
    metadata: Metadata | null;
    isAtLatest: boolean;
}): Map<string, DelegatedTaskSummary[]> {
    const scopes = new Map<string, {
        tasks: DelegatedTaskSummary[];
        rows: Array<{ id: string; time: number; index: number }>;
        end: number;
    }>();
    items.forEach((item, index) => {
        if (item.continuationBoundary) return;
        const sessionId = item.source?.sessionId ?? options.sessionId;
        if (!sessionId) return;
        let scope = scopes.get(sessionId);
        if (!scope) {
            const metadata = item.source ? item.source.metadata : options.metadata;
            scope = { tasks: (metadata?.delegationV2?.tasks ?? metadata?.delegatedTasks ?? [])
                .filter(task => task.parentSessionId === sessionId), rows: [], end: 0 };
            scopes.set(sessionId, scope);
        }
        if (!scope.tasks.length) return;
        for (const message of item.type === 'message' ? [item.message] : item.messages) {
            scope.rows.push({ id: item.id, time: message.createdAt, index });
            scope.end = Math.max(scope.end, message.createdAt,
                message.kind === 'tool-call' ? message.tool.completedAt ?? message.createdAt : message.createdAt);
        }
    });
    const anchors = new Map<string, DelegatedTaskSummary[]>();
    for (const [sessionId, scope] of scopes) {
        const rows = scope.rows.sort((a, b) => a.time - b.time || b.index - a.index);
        if (!rows.length) continue;
        for (const task of [...scope.tasks].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))) {
            if (task.parentSessionId !== sessionId || !Number.isFinite(task.startedAt)
                || task.startedAt < rows[0].time) continue;
            // A live task can precede its next provider message. Historical
            // windows must not borrow a task from an unloaded newer page.
            if (task.startedAt > scope.end
                && !(options.isAtLatest && sessionId === options.sessionId)) continue;
            let lo = 0, hi = rows.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (rows[mid].time <= task.startedAt) lo = mid + 1;
                else hi = mid;
            }
            const owner = rows[lo - 1];
            if (!owner) continue;
            const group = anchors.get(owner.id) ?? [];
            group.push(task);
            anchors.set(owner.id, group);
        }
    }
    return anchors;
}

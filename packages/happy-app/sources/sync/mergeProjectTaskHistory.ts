import type { GoalTaskSession } from '@slopus/happy-wire';
import { projectSessionMatchesTask } from './projectGoals';
import { isProjectSessionDeleted } from './projectSessionLinks';

type SessionHeader = { id: string; updatedAt: number; seq?: number; active: boolean; metadata: {
    machineId?: string; path: string; name?: string; summary?: { text: string };
    goalBoard?: { featurePath: string; taskId?: string };
} | null };

/** Share the same authoritative live headers and Task-scoped cache at every resume entry. */
export function mergeProjectTaskHistory(known: GoalTaskSession[], headers: SessionHeader[], scope: { machineId: string; featurePath: string; taskId: string; directory: string }) {
    const values = new Map(known.map(session => [session.sessionId, session]));
    for (const session of headers) {
        if (!session.metadata) continue;
        const matches = projectSessionMatchesTask(session.metadata, scope.machineId, scope.featurePath, scope.taskId, scope.directory);
        if (!matches && (session.metadata.machineId !== scope.machineId || session.metadata.goalBoard)) { values.delete(session.id); continue; }
        if (!matches && values.get(session.id)?.directory !== scope.directory) continue;
        values.set(session.id, { sessionId: session.id, title: session.metadata.summary?.text || values.get(session.id)?.title || session.metadata.name || scope.taskId,
            directory: scope.directory, updatedAt: session.updatedAt, executed: (session.seq ?? 0) > 1, active: session.active });
    }
    return [...values.values()].filter(session => !isProjectSessionDeleted(session.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
}

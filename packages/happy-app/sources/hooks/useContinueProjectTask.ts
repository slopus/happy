import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import type { GoalTask, GoalTaskSession } from '@slopus/happy-wire';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { storage } from '@/sync/storage';
import { openProjectGoalConversation } from '@/sync/projectGoals';
import { mergeProjectTaskHistory } from '@/sync/mergeProjectTaskHistory';
import { projectCacheKey, projectHistorySchema, readProjectCache, writeProjectCache } from '@/sync/projectWorkspaceCache';

/** A card continues once, preserving an uncertain request across retries and fencing navigation on blur. */
export function useContinueProjectTask({ machineId, featurePath, agent, sessions, onOpened }: {
    machineId: string; featurePath?: string; agent: 'codex' | 'claude';
    sessions?: Record<string, GoalTaskSession[]>; onOpened: (taskId: string, sessionId: string) => void;
}) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const pending = React.useRef(false);
    const requests = React.useRef(new Map<string, string>());
    const focus = React.useRef(0);
    const mounted = React.useRef(true);
    const account = getRuntimeAccountSelection();
    const scope = JSON.stringify([account?.key, account?.generation, account?.serverUrl, machineId, featurePath]);
    const current = React.useRef(scope); current.current = scope;
    useFocusEffect(React.useCallback(() => { focus.current++; return () => { focus.current++; }; }, []));
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const continueTask = async (task: GoalTask) => {
        if (pending.current || !featurePath) return;
        pending.current = true; setBusy(true); setError(null);
        const epoch = focus.current;
        const isCurrent = () => mounted.current && current.current === scope && focus.current === epoch;
        const key = JSON.stringify([scope, task.id]);
        let request = requests.current.get(key);
        if (!request) { request = `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`; requests.current.set(key, request); }
        try {
            const cacheKey = projectCacheKey('history', machineId, featurePath, task.id);
            const cached = readProjectCache(cacheKey, projectHistorySchema)?.value.sessions ?? [];
            const known = mergeProjectTaskHistory([...cached, ...(sessions?.[task.id] ?? [])], Object.values(storage.getState().sessions), {
                machineId, featurePath, taskId: task.id, directory: task.indexPath.replace(/[\\/][^\\/]+$/, ''),
            });
            const result = await openProjectGoalConversation(machineId, featurePath, task, request, agent, known);
            requests.current.delete(key);
            if (!isCurrent()) return;
            writeProjectCache(cacheKey, { sessions: [result.session, ...known.filter(value => value.sessionId !== result.session.sessionId)].slice(0, 1000) });
            onOpened(task.id, result.session.sessionId);
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
        } finally { pending.current = false; if (mounted.current) setBusy(false); }
    };
    return { continueTask, busy, error };
}

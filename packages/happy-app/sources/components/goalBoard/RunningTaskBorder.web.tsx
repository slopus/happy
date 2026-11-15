import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { RunningTaskBorderProps } from './RunningTaskBorder';
import { storage } from '@/sync/storage';
import { resolveSessionState } from '@/utils/sessionUtils';
import { mergeProjectTaskHistory } from '@/sync/mergeProjectTaskHistory';
import { projectCacheKey, projectHistorySchema, readProjectCache } from '@/sync/projectWorkspaceCache';
import { subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from '@/sync/projectSessionLinks';

const css = `@property --paws-task-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
@keyframes paws-task-flow{to{--paws-task-angle:360deg}}
.paws-task-flow{animation:paws-task-flow 3.2s linear infinite}
@media(prefers-reduced-motion:reduce){.paws-task-flow{animation:none}}`;
export function RunningTaskBorder({ task, machineId, featurePath }: RunningTaskBorderProps) {
    const { theme } = useUnistyles();
    React.useSyncExternalStore(subscribeProjectSessionDeletions, getProjectSessionDeletionRevision, getProjectSessionDeletionRevision);
    // Presence/turn updates arrive through the existing session store. Task status
    // remains the archive's acceptance state and never drives this animation.
    const cached = readProjectCache(projectCacheKey('history', machineId, featurePath, task.id), projectHistorySchema);
    const active = storage(state => {
        const history = mergeProjectTaskHistory(cached?.value.sessions ?? [], Object.values(state.sessions), {
            machineId, featurePath, taskId: task.id, directory: task.indexPath.replace(/[\\/][^\\/]+$/, ''),
        });
        return history.some(({ sessionId }) => {
            const session = state.sessions[sessionId];
            return session?.metadata?.machineId === machineId && resolveSessionState(session).state === 'running';
        });
    });
    if (!active) return null;
    return <><style>{css}</style><div aria-hidden className="paws-task-flow" style={{ position: 'absolute', inset: 0, padding: 2, zIndex: 2, borderRadius: 'inherit', pointerEvents: 'none',
        background: `conic-gradient(from var(--paws-task-angle), transparent 65%, color-mix(in srgb, ${theme.colors.textLink} 35%, transparent) 76%, ${theme.colors.textLink} 88%, ${theme.colors.textLink} 92%, transparent 98%)`,
        mask: 'linear-gradient(white 0 0) content-box, linear-gradient(white 0 0)', maskComposite: 'exclude' }} /></>;
}

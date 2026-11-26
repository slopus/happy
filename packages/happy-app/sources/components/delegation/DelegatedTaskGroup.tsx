import * as React from 'react';
import { View } from 'react-native';
import type { DelegatedTaskSummary } from '@slopus/happy-wire';
import { useSession } from '@/sync/storage';
import { useDesktopReadingWidth } from '../DesktopReadingWidth';
import { useSubagentInspector } from '../subagent/SubagentInspectorContext';
import { SubagentActivityGroup } from '../subagent/SubagentActivityGroup';
import { delegatedActivity } from './delegatedActivity';

/** Task summaries are supplied by the owning transcript row, rather than a
 * session-wide footer. Keep the existing card and inspector interaction. */
export const DelegatedTaskGroup = React.memo(function DelegatedTaskGroup({ sessionId, tasks: anchoredTasks }: {
    sessionId: string;
    tasks?: DelegatedTaskSummary[];
}) {
    const session = useSession(sessionId);
    const inspector = useSubagentInspector();
    const readingWidth = useDesktopReadingWidth();
    const tasks = anchoredTasks ?? session?.metadata?.delegationV2?.tasks ?? session?.metadata?.delegatedTasks;
    const activities = React.useMemo(() => (tasks ?? [])
        .filter(task => task.parentSessionId === sessionId).map(delegatedActivity), [tasks, sessionId]);
    if (!activities.length || !inspector) return null;
    return <View style={{ width: '100%', maxWidth: readingWidth, alignSelf: 'center', paddingHorizontal: 16, marginVertical: 10 }} testID="delegated-task-group">
        <SubagentActivityGroup activities={activities}
            selectedId={inspector.selection?.kind === 'delegated-task' ? inspector.selection.id : null}
            onOpen={activity => inspector.open({ kind: 'delegated-task', id: activity.id, parentSessionId: sessionId,
                title: activity.title, status: activity.status })} />
    </View>;
});

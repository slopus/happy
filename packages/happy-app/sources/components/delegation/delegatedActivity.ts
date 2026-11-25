import type { DelegatedTaskSummary } from '@slopus/happy-wire';
import type { SubagentConversationActivity } from '@/utils/conversationActivity';
import { t } from '@/text';

/** Reuse native subagent presentation without inserting external sessions into its tool tree. */
export function delegatedActivity(task: DelegatedTaskSummary, order: number): SubagentConversationActivity {
    const status = task.status === 'completed' ? 'completed' : task.status === 'cancelled' ? 'cancelled'
        : task.status === 'failed' || task.status === 'interrupted' ? 'failed' : 'running';
    return {
        kind: 'subagent', id: task.id, title: task.title, status, depth: 0, order,
        updatedAt: task.updatedAt, startedAt: task.startedAt,
        completedAt: task.finishedAt, provider: task.agent,
        model: task.model, effort: task.effort,
        currentAction: task.error || [task.status === 'waiting-for-input' ? t('delegation.waiting')
            : task.status === 'starting' ? t('delegation.starting') : null,
            task.roleName, task.model, task.effort].filter(Boolean).join(' · ') || null,
        failureSummary: task.error,
    };
}

/** Single-service deadline scheduling and socket invalidation; reconnect recovery never polls. */
import { db } from '@/storage/db';
import { eventRouter, buildNewMessageUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { dispatchScheduledTaskPush } from '@/app/push/pushDispatch';
import { onShutdown } from '@/utils/shutdown';
import { log } from '@/utils/log';
import { isScheduledRunTerminal } from '@slopus/happy-wire';
import { createScheduledTaskStore, type ScheduledTaskChange } from './store';
import { createDeadlineScheduler, scheduledRunDeadline } from './deadlines';

export const scheduledTaskStore = createScheduledTaskStore(db, { onMessage: created => {
    eventRouter.emitUpdate({ userId: created.accountId, recipientFilter: { type: 'all-interested-in-session', sessionId: created.sessionId },
        payload: buildNewMessageUpdate(created.message, created.sessionId, created.userSeq, randomKeyNaked(12)) });
} });
let started = false;
let retryFailedDeadlines: ((prefix: string) => void) | null = null;
export function recoverScheduledTaskDeadlines(accountId: string): void { retryFailedDeadlines?.(`${accountId}:`); }
export function wakeScheduledTasksForMachine(accountId: string, machineId: string): void {
    recoverScheduledTaskDeadlines(accountId);
    eventRouter.emitEphemeral({ userId: accountId, recipientFilter: { type: 'machine-only', machineId },
        payload: { type: 'scheduled-task-work-available', machineId } });
}

export async function startScheduledTaskScheduler(): Promise<void> {
    if (started) return;
    started = true;
    const timers = createDeadlineScheduler(error => log({ module: 'scheduled-tasks', level: 'error' }, `Scheduled deadline failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    retryFailedDeadlines = timers.retryFailed;
    const arm = ({ accountId, task, run }: ScheduledTaskChange) => {
        const key = `${accountId}:${task.id}`;
        timers.cancel(key);
        if (!task.deleted && task.enabled && task.nextAt !== null) timers.schedule(key, task.nextAt, () => scheduledTaskStore.due(accountId, task.id, Date.now()));
        if (run) {
            const runTimer = `${key}:${run.id}`;
            timers.cancel(runTimer);
            if (run.status === 'pending') wakeScheduledTasksForMachine(accountId, run.machineId);
            else if (!isScheduledRunTerminal(run.status) && run.status !== 'uncertain') {
                const deadline = scheduledRunDeadline(run);
                if (deadline) timers.schedule(runTimer, deadline.at, () => scheduledTaskStore.report(accountId, task.id, run.id, {
                    claimId: run.claimId!, status: 'uncertain', reason: deadline.reason,
                    ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.turnId ? { turnId: run.turnId } : {}),
                }, { status: run.status, updatedAt: run.updatedAt, deadlineAt: run.deadlineAt }));
            }
        }
    };
    let recovering = true;
    const buffered: ScheduledTaskChange[] = [];
    const changed = (change: ScheduledTaskChange) => {
        if (recovering) { buffered.push(change); return; }
        arm(change);
        eventRouter.emitEphemeral({ userId: change.accountId, recipientFilter: { type: 'user-scoped-only' },
            payload: { type: 'scheduled-tasks-changed', taskId: change.task.id } });
        if (change.run?.notificationPolicy !== 'none' && change.run && ['failed', 'uncertain'].includes(change.run.status)) {
            void dispatchScheduledTaskPush({ userId: change.accountId, taskId: change.task.id, runId: change.run.id, sessionId: change.run.sessionId }).catch(() => {});
        }
    };
    const unsubscribe = scheduledTaskStore.onChange(changed);
    try { for (const saved of await scheduledTaskStore.restore()) arm(saved); }
    catch (error) { unsubscribe(); timers.stop(); retryFailedDeadlines = null; started = false; throw error; }
    recovering = false;
    for (const change of buffered) changed(change);
    onShutdown('scheduled-tasks', async () => { unsubscribe(); timers.stop(); retryFailedDeadlines = null; started = false; });
}

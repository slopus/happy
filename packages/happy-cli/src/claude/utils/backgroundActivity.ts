/**
 * Summarize Claude Code's in-flight background work for session metadata.
 *
 * Claude Code reports every registered background task on the `Stop` hook
 * payload as `background_tasks: [{ id, type, status, description, ... }]`,
 * where `type` is a friendly label — 'shell', 'subagent', 'workflow',
 * 'monitor', … — falling back to the raw discriminant for unknown kinds.
 *
 * This is the only signal that survives BOTH happy-cli launch modes: the local
 * launcher drives the `claude` binary through a PTY and the remote launcher
 * drives it through the SDK, but the binary runs its hooks either way. Reading
 * it here means the app learns about background work without happy-cli having
 * to reconstruct task lifecycles from transcript records.
 *
 * Why it matters: `thinking` is turn-scoped, so a session drops to "waiting"
 * the moment the turn ends — even when a 20-minute build or a still-running
 * subagent is the whole reason the session is still alive. The counts produced
 * here let the session list say "idle, but N things are still running".
 */

/** One entry of the Stop hook's `background_tasks` array. */
export interface BackgroundTaskSummary {
    id: string;
    /** 'shell' | 'subagent' | 'workflow' | 'monitor' | raw discriminant. */
    type: string;
    status: string;
    description?: string;
    command?: string;
    subagent_type?: string;
}

/**
 * Session activity counts, shaped to the app's `metadata.activity` schema.
 * Every bucket is always present so the app's Zod object schema parses it
 * whether or not a given kind of work is running.
 */
export interface SessionActivity {
    subagents: { running: number; queued: number; total: number };
    workflows: { running: number; total: number };
    processes: { running: number };
    tasks: { pending: number; inProgress: number; completed: number; total: number };
}

export const EMPTY_ACTIVITY: SessionActivity = {
    subagents: { running: 0, queued: 0, total: 0 },
    workflows: { running: 0, total: 0 },
    processes: { running: 0 },
    tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
};

/**
 * A task Claude Code still lists is in flight by definition, but only some of
 * them have actually started. Anything not explicitly 'running' is counted as
 * queued so a large fan-out reads as "2 running +6 queued" rather than "8 running".
 */
function isRunning(status: string): boolean {
    return status.toLowerCase() === 'running';
}

function isBackgroundTask(value: unknown): value is BackgroundTaskSummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const task = value as Record<string, unknown>;
    return typeof task.id === 'string' && typeof task.type === 'string' && typeof task.status === 'string';
}

/**
 * Pull the well-formed entries out of a raw hook payload's `background_tasks`.
 * Malformed entries are dropped rather than throwing — a hook payload shape we
 * do not recognize must never take the session down.
 */
export function parseBackgroundTasks(value: unknown): BackgroundTaskSummary[] {
    return Array.isArray(value) ? value.filter(isBackgroundTask) : [];
}

/**
 * Fold background tasks into the counts the app renders.
 *
 * 'shell' and every unrecognized kind land in `processes`, which is the app's
 * generic "something is running on the machine" bucket — an unknown future task
 * type is still worth showing as activity, just without a specific icon.
 */
export function summarizeBackgroundTasks(tasks: BackgroundTaskSummary[]): SessionActivity {
    const activity: SessionActivity = {
        subagents: { running: 0, queued: 0, total: 0 },
        workflows: { running: 0, total: 0 },
        processes: { running: 0 },
        tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
    };

    for (const task of tasks) {
        const running = isRunning(task.status);
        switch (task.type.toLowerCase()) {
            case 'subagent':
                activity.subagents.total += 1;
                if (running) {
                    activity.subagents.running += 1;
                } else {
                    activity.subagents.queued += 1;
                }
                break;
            case 'workflow':
                activity.workflows.total += 1;
                if (running) {
                    activity.workflows.running += 1;
                }
                break;
            default:
                activity.processes.running += 1;
                break;
        }
    }

    return activity;
}

/** Whether an activity summary carries no in-flight work at all. */
export function isActivityEmpty(activity: SessionActivity): boolean {
    return activity.subagents.total === 0
        && activity.workflows.total === 0
        && activity.processes.running === 0
        && activity.tasks.total === 0;
}

/**
 * Structural equality, used to skip redundant metadata writes. Metadata updates
 * are read-modify-write against the server under optimistic concurrency, so
 * re-sending an identical `activity` on every idle turn is pure churn.
 */
export function activityEquals(a: SessionActivity | undefined, b: SessionActivity | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    return a.subagents.running === b.subagents.running
        && a.subagents.queued === b.subagents.queued
        && a.subagents.total === b.subagents.total
        && a.workflows.running === b.workflows.running
        && a.workflows.total === b.workflows.total
        && a.processes.running === b.processes.running
        && a.tasks.pending === b.tasks.pending
        && a.tasks.inProgress === b.tasks.inProgress
        && a.tasks.completed === b.tasks.completed
        && a.tasks.total === b.tasks.total;
}

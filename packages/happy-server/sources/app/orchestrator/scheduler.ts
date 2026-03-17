import { db } from "@/storage/db";
import { invokeUserRpc } from "@/app/api/socket/rpcRegistry";
import { log, warn } from "@/utils/log";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { randomUUID } from "node:crypto";
import {
    addTaskCount,
    createEmptySummaryInternal,
    deriveRunStatus,
    isRunTerminal,
} from "./state";

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'canceling'];
const ACTIVE_EXECUTION_STATUSES = ['dispatching', 'running'];

export const ORCHESTRATOR_SCHEDULER_INTERVAL_MS = 1_000;
export const ORCHESTRATOR_RPC_TIMEOUT_MS = 15_000;
export const ORCHESTRATOR_DISPATCH_STALE_MS = 60_000;
export const ORCHESTRATOR_DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;

export type SchedulerAction =
    | {
        type: 'dispatch';
        accountId: string;
        machineId: string;
        runId: string;
        taskId: string;
        executionId: string;
        dispatchToken: string;
        payload: {
            executionId: string;
            runId: string;
            taskId: string;
            dispatchToken: string;
            provider: string;
            prompt: string;
            timeoutMs: number;
        };
    }
    | {
        type: 'cancel';
        accountId: string;
        machineId: string;
        runId: string;
        taskId: string;
        executionId: string;
        dispatchToken: string;
        payload: {
            executionId: string;
            runId: string;
            taskId: string;
            dispatchToken: string;
        };
    };

async function recomputeRunStatusTx(tx: any, runId: string, currentStatus: string, completedAt: Date | null, now: Date): Promise<string> {
    const grouped = await tx.orchestratorTask.groupBy({
        by: ['status'],
        where: { runId },
        _count: { _all: true },
    });
    const internal = createEmptySummaryInternal();
    for (const row of grouped) {
        addTaskCount(internal, row.status, row._count._all);
    }

    const nextStatus = deriveRunStatus(currentStatus, internal);
    const shouldUpdateCompletedAt = isRunTerminal(nextStatus) && !completedAt;
    if (nextStatus !== currentStatus || shouldUpdateCompletedAt) {
        await tx.orchestratorRun.update({
            where: { id: runId },
            data: {
                status: nextStatus,
                completedAt: isRunTerminal(nextStatus) ? now : null,
            },
        });
    }
    return nextStatus;
}

async function markDispatchFailed(action: Extract<SchedulerAction, { type: 'dispatch' }>, reason: string): Promise<void> {
    const now = new Date();
    await db.$transaction(async (tx: any) => {
        const execution = await tx.orchestratorExecution.findUnique({
            where: { id: action.executionId },
            select: {
                id: true,
                status: true,
                runId: true,
                taskId: true,
                attempt: true,
            },
        });
        if (!execution || execution.status !== 'dispatching') {
            return;
        }

        const run = await tx.orchestratorRun.findUnique({
            where: { id: action.runId },
            select: { status: true, completedAt: true },
        });
        if (!run) {
            return;
        }
        const task = await tx.orchestratorTask.findUnique({
            where: { id: action.taskId },
            select: {
                retryMaxAttempts: true,
                retryBackoffMs: true,
            },
        });
        const shouldRetry = !!task
            && run.status !== 'canceling'
            && run.status !== 'cancelled'
            && execution.attempt < task.retryMaxAttempts;
        const nextAttemptAt = shouldRetry
            ? new Date(now.getTime() + task.retryBackoffMs)
            : null;

        await tx.orchestratorExecution.update({
            where: { id: action.executionId },
            data: {
                status: 'failed',
                finishedAt: now,
                errorCode: 'RPC_DISPATCH_FAILED',
                errorMessage: reason,
            },
        });
        await tx.orchestratorTask.updateMany({
            where: { id: action.taskId, status: 'dispatching' },
            data: {
                status: shouldRetry ? 'queued' : 'failed',
                errorCode: 'RPC_DISPATCH_FAILED',
                errorMessage: reason,
                nextAttemptAt,
            },
        });
        await recomputeRunStatusTx(tx, action.runId, run.status, run.completedAt, now);
    });
}

export async function executeSchedulerActions(actions: SchedulerAction[]): Promise<void> {
    for (const action of actions) {
        if (action.type === 'dispatch') {
            try {
                await invokeUserRpc(
                    action.accountId,
                    `${action.machineId}:orchestrator-dispatch`,
                    action.payload,
                    ORCHESTRATOR_RPC_TIMEOUT_MS,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                warn({ module: 'orchestrator-scheduler', runId: action.runId, executionId: action.executionId }, `Dispatch RPC failed: ${message}`);
                try {
                    await markDispatchFailed(action, message);
                } catch (markError) {
                    const markMessage = markError instanceof Error ? markError.message : String(markError);
                    warn(
                        { module: 'orchestrator-scheduler', runId: action.runId, executionId: action.executionId },
                        `markDispatchFailed failed: ${markMessage}`,
                    );
                }
            }
            continue;
        }

        try {
            await invokeUserRpc(
                action.accountId,
                `${action.machineId}:orchestrator-cancel`,
                action.payload,
                ORCHESTRATOR_RPC_TIMEOUT_MS,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warn({ module: 'orchestrator-scheduler', runId: action.runId, executionId: action.executionId }, `Cancel RPC failed: ${message}`);
        }
    }
}

async function failStaleDispatchingExecutionsTx(tx: any, runId: string, runStatus: string, now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - ORCHESTRATOR_DISPATCH_STALE_MS);
    const staleExecutions = await tx.orchestratorExecution.findMany({
        where: {
            runId,
            status: 'dispatching',
            createdAt: { lt: staleBefore },
        },
        select: {
            id: true,
            taskId: true,
            attempt: true,
            task: {
                select: {
                    retryMaxAttempts: true,
                    retryBackoffMs: true,
                },
            },
        },
    });

    for (const execution of staleExecutions) {
        const shouldRetry = runStatus !== 'canceling'
            && runStatus !== 'cancelled'
            && execution.attempt < execution.task.retryMaxAttempts;
        const nextAttemptAt = shouldRetry
            ? new Date(now.getTime() + execution.task.retryBackoffMs)
            : null;
        const updated = await tx.orchestratorExecution.updateMany({
            where: {
                id: execution.id,
                status: 'dispatching',
            },
            data: {
                status: 'failed',
                finishedAt: now,
                errorCode: 'DISPATCH_TIMEOUT',
                errorMessage: 'Dispatch did not start in time',
            },
        });
        if (updated.count === 0) {
            continue;
        }
        await tx.orchestratorTask.updateMany({
            where: { id: execution.taskId, status: 'dispatching' },
            data: {
                status: shouldRetry ? 'queued' : 'failed',
                errorCode: 'DISPATCH_TIMEOUT',
                errorMessage: 'Dispatch did not start in time',
                nextAttemptAt,
            },
        });
    }
}

async function failTimedOutRunningExecutionsTx(tx: any, runId: string, runStatus: string, now: Date): Promise<void> {
    const runningExecutions = await tx.orchestratorExecution.findMany({
        where: {
            runId,
            status: 'running',
        },
        select: {
            id: true,
            taskId: true,
            attempt: true,
            startedAt: true,
            createdAt: true,
            timeoutMs: true,
            task: {
                select: {
                    retryMaxAttempts: true,
                    retryBackoffMs: true,
                },
            },
        },
    });

    for (const execution of runningExecutions) {
        const timeoutMs = execution.timeoutMs ?? ORCHESTRATOR_DEFAULT_TASK_TIMEOUT_MS;
        const startedAt = execution.startedAt ?? execution.createdAt;
        if (now.getTime() - startedAt.getTime() < timeoutMs) {
            continue;
        }

        const updated = await tx.orchestratorExecution.updateMany({
            where: {
                id: execution.id,
                status: 'running',
            },
            data: {
                status: 'timeout',
                finishedAt: now,
                errorCode: 'TASK_TIMEOUT',
                errorMessage: `Task exceeded timeout (${timeoutMs}ms)`,
            },
        });
        if (updated.count === 0) {
            continue;
        }

        const shouldRetry = runStatus !== 'canceling'
            && runStatus !== 'cancelled'
            && execution.attempt < execution.task.retryMaxAttempts;
        const nextAttemptAt = shouldRetry
            ? new Date(now.getTime() + execution.task.retryBackoffMs)
            : null;
        await tx.orchestratorTask.updateMany({
            where: { id: execution.taskId, status: 'running' },
            data: {
                status: shouldRetry ? 'queued' : 'failed',
                errorCode: 'TASK_TIMEOUT',
                errorMessage: `Task exceeded timeout (${timeoutMs}ms)`,
                nextAttemptAt,
            },
        });
    }
}

async function buildRunActions(run: {
    id: string;
    accountId: string;
    status: string;
    maxConcurrency: number;
}, now: Date): Promise<SchedulerAction[]> {
    const actions: SchedulerAction[] = [];
    await db.$transaction(async (tx: any) => {
        const currentRun = await tx.orchestratorRun.findUnique({
            where: { id: run.id },
            select: {
                id: true,
                accountId: true,
                status: true,
                maxConcurrency: true,
                completedAt: true,
            },
        });
        if (!currentRun || isRunTerminal(currentRun.status)) {
            return;
        }

        await failStaleDispatchingExecutionsTx(tx, currentRun.id, currentRun.status, now);
        await failTimedOutRunningExecutionsTx(tx, currentRun.id, currentRun.status, now);

        if (currentRun.status === 'canceling') {
            await tx.orchestratorTask.updateMany({
                where: {
                    runId: currentRun.id,
                    status: 'queued',
                },
                data: {
                    status: 'cancelled',
                    errorCode: 'RUN_CANCELLED',
                    errorMessage: 'Cancelled before dispatch',
                    nextAttemptAt: null,
                },
            });

            const activeExecutions = await tx.orchestratorExecution.findMany({
                where: {
                    runId: currentRun.id,
                    status: { in: ACTIVE_EXECUTION_STATUSES },
                },
                select: {
                    id: true,
                    runId: true,
                    taskId: true,
                    machineId: true,
                    dispatchToken: true,
                },
            });
            for (const execution of activeExecutions) {
                actions.push({
                    type: 'cancel',
                    accountId: currentRun.accountId,
                    machineId: execution.machineId,
                    runId: execution.runId,
                    taskId: execution.taskId,
                    executionId: execution.id,
                    dispatchToken: execution.dispatchToken,
                    payload: {
                        executionId: execution.id,
                        runId: execution.runId,
                        taskId: execution.taskId,
                        dispatchToken: execution.dispatchToken,
                    },
                });
            }
        } else {
            const activeExecutionCount = await tx.orchestratorExecution.count({
                where: {
                    runId: currentRun.id,
                    status: { in: ACTIVE_EXECUTION_STATUSES },
                },
            });
            const slots = Math.max(0, currentRun.maxConcurrency - activeExecutionCount);
            if (slots > 0) {
                const queuedTasks = await tx.orchestratorTask.findMany({
                    where: {
                        runId: currentRun.id,
                        status: 'queued',
                        OR: [
                            { nextAttemptAt: null },
                            { nextAttemptAt: { lte: now } },
                        ],
                    },
                    orderBy: { seq: 'asc' },
                    select: {
                        id: true,
                        runId: true,
                        taskKey: true,
                        dependsOnTaskKeys: true,
                        provider: true,
                        prompt: true,
                        timeoutMs: true,
                        targetMachineId: true,
                        nextAttemptAt: true,
                    },
                });
                const keyedTasks = await tx.orchestratorTask.findMany({
                    where: {
                        runId: currentRun.id,
                        taskKey: { not: null },
                    },
                    select: {
                        taskKey: true,
                        status: true,
                    },
                });
                const taskKeyToStatus = new Map<string, string>();
                for (const keyedTask of keyedTasks) {
                    if (keyedTask.taskKey) {
                        taskKeyToStatus.set(keyedTask.taskKey, keyedTask.status);
                    }
                }
                const readyTasks: typeof queuedTasks = [];
                for (const task of queuedTasks) {
                    const dependencies = task.dependsOnTaskKeys ?? [];
                    if (dependencies.length === 0) {
                        readyTasks.push(task);
                        continue;
                    }

                    let dependencyFailedMessage: string | null = null;
                    let blocked = false;
                    for (const dependencyKey of dependencies) {
                        const dependencyStatus = taskKeyToStatus.get(dependencyKey);
                        if (!dependencyStatus) {
                            dependencyFailedMessage = `Dependency not found: ${dependencyKey}`;
                            break;
                        }
                        if (dependencyStatus === 'failed' || dependencyStatus === 'cancelled' || dependencyStatus === 'dependency_failed') {
                            dependencyFailedMessage = `Dependency failed: ${dependencyKey}`;
                            break;
                        }
                        if (dependencyStatus !== 'completed') {
                            blocked = true;
                        }
                    }

                    if (dependencyFailedMessage) {
                        await tx.orchestratorTask.updateMany({
                            where: { id: task.id, status: 'queued' },
                            data: {
                                status: 'dependency_failed',
                                errorCode: 'DEPENDENCY_FAILED',
                                errorMessage: dependencyFailedMessage,
                                nextAttemptAt: null,
                            },
                        });
                        continue;
                    }

                    if (!blocked) {
                        readyTasks.push(task);
                    }
                }

                const targetMachineIds = [...new Set(readyTasks
                    .map((task: any) => task.targetMachineId)
                    .filter((machineId: string | null) => !!machineId))];
                const targetMachines = targetMachineIds.length > 0
                    ? await tx.machine.findMany({
                        where: {
                            accountId: currentRun.accountId,
                            id: { in: targetMachineIds },
                        },
                        select: { id: true },
                    })
                    : [];
                const allowedTargetMachineIds = new Set(targetMachines.map((machine: any) => machine.id));

                const defaultMachine = await tx.machine.findFirst({
                    where: {
                        accountId: currentRun.accountId,
                        active: true,
                    },
                    orderBy: { lastActiveAt: 'desc' },
                    select: { id: true },
                });

                for (const task of readyTasks.slice(0, slots)) {
                    if (task.targetMachineId && !allowedTargetMachineIds.has(task.targetMachineId)) {
                        await tx.orchestratorTask.updateMany({
                            where: { id: task.id, status: 'queued' },
                            data: {
                                status: 'failed',
                                errorCode: 'MACHINE_UNAVAILABLE',
                                errorMessage: `Target machine not found: ${task.targetMachineId}`,
                            },
                        });
                        continue;
                    }

                    const machineId = task.targetMachineId ?? defaultMachine?.id ?? null;
                    if (!machineId) {
                        await tx.orchestratorTask.updateMany({
                            where: { id: task.id, status: 'queued' },
                            data: {
                                status: 'failed',
                                errorCode: 'MACHINE_UNAVAILABLE',
                                errorMessage: 'No available machine to run task',
                            },
                        });
                        continue;
                    }

                    const moved = await tx.orchestratorTask.updateMany({
                        where: {
                            id: task.id,
                            status: 'queued',
                        },
                        data: {
                            status: 'dispatching',
                            nextAttemptAt: null,
                        },
                    });
                    if (moved.count === 0) {
                        continue;
                    }

                    const timeoutMs = task.timeoutMs ?? ORCHESTRATOR_DEFAULT_TASK_TIMEOUT_MS;
                    const dispatchToken = randomUUID();
                    const latestExecution = await tx.orchestratorExecution.findFirst({
                        where: {
                            taskId: task.id,
                        },
                        orderBy: {
                            attempt: 'desc',
                        },
                        select: {
                            attempt: true,
                        },
                    });
                    const attempt = (latestExecution?.attempt ?? 0) + 1;
                    const execution = await tx.orchestratorExecution.create({
                        data: {
                            runId: task.runId,
                            taskId: task.id,
                            machineId,
                            provider: task.provider,
                            status: 'dispatching',
                            attempt,
                            dispatchToken,
                            timeoutMs,
                        },
                        select: {
                            id: true,
                            runId: true,
                            taskId: true,
                            machineId: true,
                            dispatchToken: true,
                        },
                    });

                    actions.push({
                        type: 'dispatch',
                        accountId: currentRun.accountId,
                        machineId: execution.machineId,
                        runId: execution.runId,
                        taskId: execution.taskId,
                        executionId: execution.id,
                        dispatchToken: execution.dispatchToken,
                        payload: {
                            executionId: execution.id,
                            runId: execution.runId,
                            taskId: execution.taskId,
                            dispatchToken: execution.dispatchToken,
                            provider: task.provider,
                            prompt: task.prompt,
                            timeoutMs,
                        },
                    });
                }
            }
        }

        const refreshedRun = await tx.orchestratorRun.findUnique({
            where: { id: currentRun.id },
            select: {
                status: true,
                completedAt: true,
            },
        });
        if (refreshedRun) {
            await recomputeRunStatusTx(tx, currentRun.id, refreshedRun.status, refreshedRun.completedAt, now);
        }
    });

    return actions;
}

export async function orchestratorSchedulerTick(now: Date = new Date()): Promise<void> {
    // v2.1: each tick processes at most 50 active runs.
    // Additional active runs are handled by subsequent ticks.
    const runs = await db.orchestratorRun.findMany({
        where: {
            status: { in: ACTIVE_RUN_STATUSES },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: {
            id: true,
            accountId: true,
            status: true,
            maxConcurrency: true,
        },
    });

    for (const run of runs) {
        const actions = await buildRunActions(run, now);
        await executeSchedulerActions(actions);
    }
}

export function startOrchestratorScheduler() {
    forever('orchestrator-scheduler', async () => {
        while (true) {
            try {
                await orchestratorSchedulerTick();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                warn({ module: 'orchestrator-scheduler' }, `schedulerTick failed: ${message}`);
            }
            await delay(ORCHESTRATOR_SCHEDULER_INTERVAL_MS, shutdownSignal);
        }
    });
    log({ module: 'orchestrator-scheduler' }, 'Orchestrator scheduler started');
}

import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { delay } from "@/utils/delay";
import {
    addTaskCount,
    buildPendCursor,
    createEmptySummaryInternal,
    decodeListCursor,
    deriveRunStatus,
    encodeListCursor,
    isExecutionTerminal,
    isRunTerminal,
    type RunSummary,
    toPublicSummary,
} from "@/app/orchestrator/state";

const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
const RUN_STATUSES = ['queued', 'running', 'canceling', 'completed', 'failed', 'cancelled'] as const;
const EXECUTION_FINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'] as const;
const LIST_RUN_STATUS_FILTERS = ['active', 'terminal', ...RUN_STATUSES] as const;

const submitTaskSchema = z.object({
    taskKey: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(256).optional(),
    provider: z.enum(PROVIDERS),
    prompt: z.string().min(1).max(65536),
    timeoutMs: z.coerce.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
    target: z.object({
        type: z.enum(['current_machine', 'machine_id']),
        machineId: z.string().optional(),
    }).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
}).refine((value) => {
    if (value.target?.type === 'machine_id') {
        return !!value.target.machineId;
    }
    return true;
}, {
    message: 'target.machineId is required when target.type is machine_id',
    path: ['target', 'machineId'],
});

const submitBodySchema = z.object({
    title: z.string().min(1).max(256),
    controllerSessionId: z.string().optional(),
    tasks: z.array(submitTaskSchema).min(1).max(32),
    maxConcurrency: z.coerce.number().int().min(1).max(8).optional(),
    mode: z.enum(['blocking', 'async']).optional(),
    waitTimeoutMs: z.coerce.number().int().min(1000).max(60 * 60 * 1000).optional(),
    pollIntervalMs: z.coerce.number().int().min(200).max(60_000).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

type RunWithTasks = {
    id: string;
    title: string;
    status: string;
    maxConcurrency: number;
    controllerSessionId: string | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
    cancelRequestedAt: Date | null;
    tasks: Array<{
        id: string;
        seq: number;
        taskKey: string | null;
        title: string | null;
        provider: string;
        status: string;
        outputSummary: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
};

function sendError(reply: any, statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    return reply.code(statusCode).send({
        ok: false,
        error: {
            code,
            message,
            ...(details ? { details } : {}),
        },
    });
}

function isUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    if (!('code' in error)) {
        return false;
    }
    return (error as { code?: unknown }).code === 'P2002';
}

function mapTask(task: RunWithTasks['tasks'][number]) {
    return {
        taskId: task.id,
        seq: task.seq,
        taskKey: task.taskKey,
        title: task.title,
        status: task.status,
        provider: task.provider,
        outputSummary: task.outputSummary,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
    };
}

function mapRunResponse(run: RunWithTasks, summary: RunSummary, includeTasks: boolean) {
    return {
        runId: run.id,
        title: run.title,
        status: run.status,
        maxConcurrency: run.maxConcurrency,
        controllerSessionId: run.controllerSessionId,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
        summary,
        ...(includeTasks ? { tasks: run.tasks.map(mapTask) } : {}),
    };
}

function summarizeTasksByStatus(tasks: Array<{ status: string }>): RunSummary {
    const internal = createEmptySummaryInternal();
    for (const task of tasks) {
        addTaskCount(internal, task.status, 1);
    }
    return toPublicSummary(internal);
}

function summaryFromGrouped(grouped: Array<{ status: string; _count: { _all: number } }>): RunSummary {
    const internal = createEmptySummaryInternal();
    for (const row of grouped) {
        addTaskCount(internal, row.status, row._count._all);
    }
    return toPublicSummary(internal);
}

function summaryMapFromGrouped(grouped: Array<{ runId: string; status: string; _count: { _all: number } }>): Map<string, RunSummary> {
    const internalByRun = new Map<string, ReturnType<typeof createEmptySummaryInternal>>();
    for (const row of grouped) {
        let summary = internalByRun.get(row.runId);
        if (!summary) {
            summary = createEmptySummaryInternal();
            internalByRun.set(row.runId, summary);
        }
        addTaskCount(summary, row.status, row._count._all);
    }

    const out = new Map<string, RunSummary>();
    for (const [runId, internal] of internalByRun.entries()) {
        out.set(runId, toPublicSummary(internal));
    }
    return out;
}

async function loadRunForUser(userId: string, runId: string, includeTasks: boolean): Promise<{ run: RunWithTasks; summary: RunSummary } | null> {
    const run = await db.orchestratorRun.findFirst({
        where: { id: runId, accountId: userId },
        select: {
            id: true,
            title: true,
            status: true,
            maxConcurrency: true,
            controllerSessionId: true,
            createdAt: true,
            updatedAt: true,
            completedAt: true,
            cancelRequestedAt: true,
            tasks: includeTasks ? {
                orderBy: { seq: 'asc' },
                select: {
                    id: true,
                    seq: true,
                    taskKey: true,
                    title: true,
                    provider: true,
                    status: true,
                    outputSummary: true,
                    errorCode: true,
                    errorMessage: true,
                    createdAt: true,
                    updatedAt: true,
                },
            } : false,
        },
    });

    if (!run) {
        return null;
    }

    if (includeTasks) {
        return { run: run as RunWithTasks, summary: summarizeTasksByStatus(run.tasks) };
    }

    const grouped = await db.orchestratorTask.groupBy({
        by: ['status'],
        where: { runId: run.id },
        _count: { _all: true },
    });
    return {
        run: { ...run, tasks: [] } as RunWithTasks,
        summary: summaryFromGrouped(grouped),
    };
}

function resolveRunStatusFilter(status?: string): string[] | undefined {
    if (!status) {
        return undefined;
    }
    if (status === 'active') {
        return ['queued', 'running', 'canceling'];
    }
    if (status === 'terminal') {
        return ['completed', 'failed', 'cancelled'];
    }
    return [status];
}

function validateTaskKeyUniqueness(tasks: z.infer<typeof submitTaskSchema>[]): string | null {
    const seen = new Set<string>();
    for (const task of tasks) {
        if (!task.taskKey) {
            continue;
        }
        if (seen.has(task.taskKey)) {
            return task.taskKey;
        }
        seen.add(task.taskKey);
    }
    return null;
}

export function orchestratorRoutes(app: Fastify) {
    app.post('/v1/orchestrator/submit', {
        preHandler: app.authenticate,
        schema: {
            body: submitBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body;

        const duplicatedTaskKey = validateTaskKeyUniqueness(body.tasks);
        if (duplicatedTaskKey) {
            return sendError(reply, 400, 'INVALID_ARGUMENT', `Duplicate taskKey in request: ${duplicatedTaskKey}`);
        }

        if (body.controllerSessionId) {
            const controllerSession = await db.session.findFirst({
                where: {
                    id: body.controllerSessionId,
                    accountId: userId,
                },
                select: { id: true },
            });
            if (!controllerSession) {
                return sendError(reply, 400, 'INVALID_ARGUMENT', 'controllerSessionId does not belong to current account');
            }
        }

        const loadExistingByIdempotency = async (): Promise<{ run: RunWithTasks; summary: RunSummary } | null> => {
            if (!body.idempotencyKey) {
                return null;
            }
            const existing = await db.orchestratorRun.findFirst({
                where: {
                    accountId: userId,
                    idempotencyKey: body.idempotencyKey,
                },
                select: { id: true },
            });
            if (!existing) {
                return null;
            }
            return loadRunForUser(userId, existing.id, true);
        };

        const existing = await loadExistingByIdempotency();
        if (existing) {
            return reply.send({
                ok: true,
                data: {
                    runId: existing.run.id,
                    mode: body.mode ?? 'async',
                    terminal: isRunTerminal(existing.run.status),
                    run: {
                        status: existing.run.status,
                        createdAt: existing.run.createdAt.toISOString(),
                        updatedAt: existing.run.updatedAt.toISOString(),
                        summary: existing.summary,
                    },
                    tasks: existing.run.tasks.map(mapTask),
                    next: isRunTerminal(existing.run.status) ? undefined : { tool: 'orchestrator_pend', runId: existing.run.id },
                },
            });
        }

        try {
            const created = await db.$transaction(async (tx: any) => {
                const run = await tx.orchestratorRun.create({
                    data: {
                        accountId: userId,
                        controllerSessionId: body.controllerSessionId,
                        title: body.title,
                        status: 'queued',
                        maxConcurrency: body.maxConcurrency ?? 2,
                        idempotencyKey: body.idempotencyKey,
                        metadata: body.metadata ?? undefined,
                    },
                    select: {
                        id: true,
                        title: true,
                        status: true,
                        maxConcurrency: true,
                        controllerSessionId: true,
                        createdAt: true,
                        updatedAt: true,
                        completedAt: true,
                        cancelRequestedAt: true,
                    },
                });

                const taskData = body.tasks.map((task, index) => ({
                    runId: run.id,
                    seq: index + 1,
                    taskKey: task.taskKey,
                    title: task.title,
                    provider: task.provider,
                    prompt: task.prompt,
                    timeoutMs: task.timeoutMs,
                    targetMachineId: task.target?.type === 'machine_id' ? task.target.machineId : null,
                    status: 'queued',
                }));

                await tx.orchestratorTask.createMany({ data: taskData });

                const tasks = await tx.orchestratorTask.findMany({
                    where: { runId: run.id },
                    orderBy: { seq: 'asc' },
                    select: {
                        id: true,
                        seq: true,
                        taskKey: true,
                        title: true,
                        provider: true,
                        status: true,
                        outputSummary: true,
                        errorCode: true,
                        errorMessage: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                });

                return {
                    run: {
                        ...run,
                        tasks,
                    } as RunWithTasks,
                    summary: summarizeTasksByStatus(tasks),
                };
            });

            return reply.send({
                ok: true,
                data: {
                    runId: created.run.id,
                    mode: body.mode ?? 'async',
                    terminal: false,
                    run: {
                        status: created.run.status,
                        createdAt: created.run.createdAt.toISOString(),
                        updatedAt: created.run.updatedAt.toISOString(),
                        summary: created.summary,
                    },
                    tasks: created.run.tasks.map(mapTask),
                    next: { tool: 'orchestrator_pend', runId: created.run.id },
                },
            });
        } catch (error) {
            if (body.idempotencyKey && isUniqueConstraintError(error)) {
                const duplicate = await loadExistingByIdempotency();
                if (duplicate) {
                    return reply.send({
                        ok: true,
                        data: {
                            runId: duplicate.run.id,
                            mode: body.mode ?? 'async',
                            terminal: isRunTerminal(duplicate.run.status),
                            run: {
                                status: duplicate.run.status,
                                createdAt: duplicate.run.createdAt.toISOString(),
                                updatedAt: duplicate.run.updatedAt.toISOString(),
                                summary: duplicate.summary,
                            },
                            tasks: duplicate.run.tasks.map(mapTask),
                            next: isRunTerminal(duplicate.run.status) ? undefined : { tool: 'orchestrator_pend', runId: duplicate.run.id },
                        },
                    });
                }
            }
            return sendError(reply, 500, 'INTERNAL', 'Failed to submit orchestrator run');
        }
    });

    app.get('/v1/orchestrator/runs/:runId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                runId: z.string(),
            }),
            querystring: z.object({
                includeTasks: z.coerce.boolean().default(true),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { runId } = request.params;
        const includeTasks = request.query?.includeTasks ?? true;

        const loaded = await loadRunForUser(userId, runId, includeTasks);
        if (!loaded) {
            return sendError(reply, 404, 'NOT_FOUND', 'Run not found');
        }

        return reply.send({
            ok: true,
            data: mapRunResponse(loaded.run, loaded.summary, includeTasks),
        });
    });

    app.get('/v1/orchestrator/runs', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                status: z.enum(LIST_RUN_STATUS_FILTERS).optional(),
                limit: z.coerce.number().int().min(1).max(50).default(20),
                cursor: z.string().optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit ?? 20;
        const statusFilter = request.query?.status;
        const cursor = request.query?.cursor;

        let cursorParts: { createdAt: Date; id: string } | null = null;
        if (cursor) {
            cursorParts = decodeListCursor(cursor);
            if (!cursorParts) {
                return sendError(reply, 400, 'INVALID_ARGUMENT', 'Invalid cursor');
            }
        }

        const resolvedStatuses = resolveRunStatusFilter(statusFilter);
        const where: any = {
            accountId: userId,
            ...(resolvedStatuses ? { status: { in: resolvedStatuses } } : {}),
        };

        if (cursorParts) {
            where.OR = [
                { createdAt: { lt: cursorParts.createdAt } },
                {
                    AND: [
                        { createdAt: cursorParts.createdAt },
                        { id: { lt: cursorParts.id } },
                    ],
                },
            ];
        }

        const runs = await db.orchestratorRun.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true,
                title: true,
                status: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        const hasNext = runs.length > limit;
        const page = hasNext ? runs.slice(0, limit) : runs;
        const runIds = page.map((run: any) => run.id);

        const summaryMap = runIds.length === 0
            ? new Map<string, RunSummary>()
            : summaryMapFromGrouped(await db.orchestratorTask.groupBy({
                by: ['runId', 'status'],
                where: { runId: { in: runIds } },
                _count: { _all: true },
            }));

        const items = page.map((run: any) => ({
            runId: run.id,
            title: run.title,
            status: run.status,
            createdAt: run.createdAt.toISOString(),
            updatedAt: run.updatedAt.toISOString(),
            summary: summaryMap.get(run.id) ?? {
                total: 0,
                queued: 0,
                running: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            },
        }));

        let nextCursor: string | undefined;
        if (hasNext && page.length > 0) {
            const last = page[page.length - 1];
            nextCursor = encodeListCursor(last.createdAt, last.id);
        }

        return reply.send({
            ok: true,
            data: {
                items,
                nextCursor,
            },
        });
    });

    app.get('/v1/orchestrator/runs/:runId/pend', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                runId: z.string(),
            }),
            querystring: z.object({
                cursor: z.string().optional(),
                waitFor: z.enum(['change', 'terminal']).default('change'),
                timeoutMs: z.coerce.number().int().min(0).max(120_000).default(30_000),
                include: z.enum(['summary', 'all_tasks']).default('summary'),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { runId } = request.params;
        const waitFor = request.query?.waitFor ?? 'change';
        const timeoutMs = request.query?.timeoutMs ?? 30_000;
        const include = request.query?.include ?? 'summary';
        const previousCursor = request.query?.cursor;
        const includeTasks = include !== 'summary';

        const startedAtMs = Date.now();
        const pollIntervalMs = 1000;

        while (true) {
            const loaded = await loadRunForUser(userId, runId, includeTasks);
            if (!loaded) {
                return sendError(reply, 404, 'NOT_FOUND', 'Run not found');
            }

            const terminal = isRunTerminal(loaded.run.status);
            const cursor = buildPendCursor({
                runId: loaded.run.id,
                updatedAt: loaded.run.updatedAt,
                status: loaded.run.status,
                summary: loaded.summary,
            });
            const changed = !previousCursor || previousCursor !== cursor;
            const waitSatisfied = waitFor === 'terminal' ? terminal : changed;

            if (waitSatisfied || Date.now() - startedAtMs >= timeoutMs) {
                return reply.send({
                    ok: true,
                    data: {
                        runId: loaded.run.id,
                        terminal,
                        changed,
                        cursor,
                        run: {
                            status: loaded.run.status,
                            summary: loaded.summary,
                            updatedAt: loaded.run.updatedAt.toISOString(),
                        },
                        ...(includeTasks ? { tasks: loaded.run.tasks.map(mapTask) } : {}),
                    },
                });
            }

            await delay(pollIntervalMs);
        }
    });

    app.post('/v1/orchestrator/runs/:runId/cancel', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                runId: z.string(),
            }),
            body: z.object({
                reason: z.string().max(512).optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { runId } = request.params;

        const result = await db.$transaction(async (tx: any) => {
            const run = await tx.orchestratorRun.findFirst({
                where: { id: runId, accountId: userId },
                select: { id: true, status: true },
            });
            if (!run) {
                return { kind: 'not_found' as const };
            }

            if (isRunTerminal(run.status)) {
                return { kind: 'ok' as const, status: run.status };
            }

            if (run.status !== 'canceling') {
                await tx.orchestratorRun.update({
                    where: { id: runId },
                    data: {
                        status: 'canceling',
                        cancelRequestedAt: new Date(),
                    },
                });
            }

            await tx.orchestratorTask.updateMany({
                where: {
                    runId,
                    status: 'queued',
                },
                data: {
                    status: 'cancelled',
                    errorCode: 'RUN_CANCELLED',
                    errorMessage: 'Cancelled before dispatch',
                },
            });

            const grouped = await tx.orchestratorTask.groupBy({
                by: ['status'],
                where: { runId },
                _count: { _all: true },
            });

            const internal = createEmptySummaryInternal();
            for (const row of grouped) {
                addTaskCount(internal, row.status, row._count._all);
            }
            const nextStatus = deriveRunStatus('canceling', internal);
            if (nextStatus !== 'canceling') {
                await tx.orchestratorRun.update({
                    where: { id: runId },
                    data: {
                        status: nextStatus,
                        completedAt: new Date(),
                    },
                });
            }

            return { kind: 'ok' as const, status: nextStatus };
        });

        if (result.kind === 'not_found') {
            return sendError(reply, 404, 'NOT_FOUND', 'Run not found');
        }

        return reply.send({
            ok: true,
            data: {
                runId,
                status: result.status,
                accepted: true,
            },
        });
    });

    app.post('/v1/orchestrator/executions/:id/start', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                dispatchToken: z.string().min(1),
                startedAt: z.string().datetime().optional(),
                pid: z.number().int().optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { dispatchToken, startedAt, pid } = request.body;

        const result = await db.$transaction(async (tx: any) => {
            const execution = await tx.orchestratorExecution.findFirst({
                where: {
                    id,
                    run: {
                        accountId: userId,
                    },
                },
                select: {
                    id: true,
                    status: true,
                    dispatchToken: true,
                    taskId: true,
                    runId: true,
                    run: {
                        select: {
                            status: true,
                        },
                    },
                },
            });

            if (!execution) {
                return { kind: 'not_found' as const };
            }

            if (execution.dispatchToken !== dispatchToken) {
                return { kind: 'token_mismatch' as const };
            }

            if (isExecutionTerminal(execution.status)) {
                return { kind: 'duplicate' as const, status: execution.status };
            }

            if (execution.run.status === 'canceling' || execution.run.status === 'cancelled') {
                return { kind: 'ignored' as const, status: execution.status };
            }

            const startedAtDate = startedAt ? new Date(startedAt) : new Date();

            const updated = await tx.orchestratorExecution.updateMany({
                where: {
                    id,
                    status: 'dispatching',
                },
                data: {
                    status: 'running',
                    startedAt: startedAtDate,
                    pid,
                },
            });
            if (updated.count === 0) {
                return { kind: 'duplicate' as const };
            }

            await tx.orchestratorTask.updateMany({
                where: {
                    id: execution.taskId,
                    status: 'dispatching',
                },
                data: {
                    status: 'running',
                },
            });

            await tx.orchestratorRun.updateMany({
                where: {
                    id: execution.runId,
                    status: { in: ['queued', 'running'] },
                },
                data: {
                    status: 'running',
                },
            });

            return { kind: 'ok' as const };
        });

        if (result.kind === 'not_found') {
            return sendError(reply, 404, 'NOT_FOUND', 'Execution not found');
        }
        if (result.kind === 'token_mismatch') {
            return sendError(reply, 409, 'CONFLICT', 'dispatchToken mismatch');
        }
        if (result.kind === 'duplicate') {
            return reply.send({ ok: true, data: { duplicate: true } });
        }
        if (result.kind === 'ignored') {
            return reply.send({ ok: true, data: { ignored: true } });
        }

        return reply.send({
            ok: true,
            data: { started: true },
        });
    });

    app.post('/v1/orchestrator/executions/:id/finish', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                dispatchToken: z.string().min(1),
                status: z.enum(EXECUTION_FINAL_STATUSES),
                finishedAt: z.string().datetime().optional(),
                exitCode: z.number().int().nullable().optional(),
                signal: z.string().nullable().optional(),
                outputSummary: z.string().nullable().optional(),
                outputText: z.string().nullable().optional(),
                errorCode: z.string().nullable().optional(),
                errorMessage: z.string().nullable().optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const body = request.body;

        const result = await db.$transaction(async (tx: any) => {
            const execution = await tx.orchestratorExecution.findFirst({
                where: {
                    id,
                    run: {
                        accountId: userId,
                    },
                },
                select: {
                    id: true,
                    status: true,
                    dispatchToken: true,
                    runId: true,
                    taskId: true,
                    run: {
                        select: {
                            status: true,
                        },
                    },
                },
            });

            if (!execution) {
                return { kind: 'not_found' as const };
            }

            if (execution.dispatchToken !== body.dispatchToken) {
                return { kind: 'token_mismatch' as const };
            }

            if (isExecutionTerminal(execution.status)) {
                return { kind: 'duplicate' as const };
            }

            const finishedAt = body.finishedAt ? new Date(body.finishedAt) : new Date();
            const executionStatus = body.status;
            const taskStatus = executionStatus === 'completed'
                ? 'completed'
                : executionStatus === 'cancelled'
                    ? 'cancelled'
                    : 'failed';

            const updated = await tx.orchestratorExecution.updateMany({
                where: {
                    id,
                    status: { in: ['dispatching', 'running'] },
                },
                data: {
                    status: executionStatus,
                    finishedAt,
                    exitCode: body.exitCode ?? null,
                    signal: body.signal ?? null,
                    outputSummary: body.outputSummary ?? null,
                    outputText: body.outputText ?? null,
                    errorCode: body.errorCode ?? null,
                    errorMessage: body.errorMessage ?? null,
                },
            });
            if (updated.count === 0) {
                return { kind: 'duplicate' as const };
            }

            await tx.orchestratorTask.updateMany({
                where: {
                    id: execution.taskId,
                    status: { in: ['dispatching', 'running'] },
                },
                data: {
                    status: taskStatus,
                    outputSummary: body.outputSummary ?? null,
                    outputText: body.outputText ?? null,
                    errorCode: body.errorCode ?? null,
                    errorMessage: body.errorMessage ?? null,
                },
            });

            const grouped = await tx.orchestratorTask.groupBy({
                by: ['status'],
                where: { runId: execution.runId },
                _count: { _all: true },
            });
            const internal = createEmptySummaryInternal();
            for (const row of grouped) {
                addTaskCount(internal, row.status, row._count._all);
            }

            const nextRunStatus = deriveRunStatus(execution.run.status, internal);
            await tx.orchestratorRun.update({
                where: { id: execution.runId },
                data: {
                    status: nextRunStatus,
                    completedAt: isRunTerminal(nextRunStatus) ? finishedAt : null,
                },
            });

            return {
                kind: 'ok' as const,
                runStatus: nextRunStatus,
            };
        });

        if (result.kind === 'not_found') {
            return sendError(reply, 404, 'NOT_FOUND', 'Execution not found');
        }
        if (result.kind === 'token_mismatch') {
            return sendError(reply, 409, 'CONFLICT', 'dispatchToken mismatch');
        }
        if (result.kind === 'duplicate') {
            return reply.send({ ok: true, data: { duplicate: true } });
        }

        return reply.send({
            ok: true,
            data: {
                finished: true,
                runStatus: result.runStatus,
            },
        });
    });
}

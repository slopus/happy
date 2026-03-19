import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '@/app/api/types';
import { CLAUDE_MODEL_MODES, CODEX_MODEL_MODES, GEMINI_MODEL_MODES } from 'happy-wire';

type RunStatus = 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled';
type TaskStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dependency_failed';
type ExecutionStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

type RunRecord = {
    id: string;
    accountId: string;
    title: string;
    status: RunStatus;
    maxConcurrency: number;
    controllerSessionId: string | null;
    idempotencyKey: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
    cancelRequestedAt: Date | null;
};

type TaskRecord = {
    id: string;
    runId: string;
    seq: number;
    taskKey: string | null;
    title: string | null;
    provider: 'claude' | 'codex' | 'gemini';
    model: string | null;
    prompt: string;
    workingDirectory: string | null;
    timeoutMs: number | null;
    targetMachineId: string | null;
    dependsOnTaskKeys: string[];
    retryMaxAttempts: number;
    retryBackoffMs: number;
    nextAttemptAt: Date | null;
    status: TaskStatus;
    outputSummary: string | null;
    outputText: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type ExecutionRecord = {
    id: string;
    runId: string;
    taskId: string;
    machineId: string;
    provider: 'claude' | 'codex' | 'gemini';
    model: string | null;
    childSessionId: string | null;
    executionType: 'initial' | 'resume';
    resumeMessage: string | null;
    status: ExecutionStatus;
    attempt: number;
    dispatchToken: string;
    timeoutMs: number | null;
    pid: number | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    exitCode: number | null;
    signal: string | null;
    outputSummary: string | null;
    outputText: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type MachineRecord = {
    id: string;
    accountId: string;
    active: boolean;
    lastActiveAt: Date;
};

const {
    state,
    resetState,
    dbMock,
    invokeUserRpcMock,
    listConnectedUserRpcMethodsMock,
    eventRouterMock,
} = vi.hoisted(() => {
    const state = {
        nowMs: Date.parse('2026-03-16T00:00:00.000Z'),
        runSeq: 1,
        taskSeq: 1,
        executionSeq: 1,
        runs: [] as RunRecord[],
        tasks: [] as TaskRecord[],
        executions: [] as ExecutionRecord[],
        machines: [] as MachineRecord[],
        sessions: [] as Array<{ id: string; accountId: string }>,
        accessKeys: [] as Array<{ accountId: string; machineId: string; sessionId: string; updatedAt: Date }>,
        onlineMachineIds: new Set<string>(),
        dispatchReadyMachineIds: new Set<string>(),
    };

    const nextDate = () => {
        const value = new Date(state.nowMs);
        state.nowMs += 1;
        return value;
    };

    const resetState = () => {
        state.nowMs = Date.parse('2026-03-16T00:00:00.000Z');
        state.runSeq = 1;
        state.taskSeq = 1;
        state.executionSeq = 1;
        state.runs = [];
        state.tasks = [];
        state.executions = [];
        state.machines = [
            {
                id: 'machine-1',
                accountId: 'user-1',
                active: true,
                lastActiveAt: new Date('2026-03-16T00:00:00.000Z'),
            },
        ];
        state.sessions = [
            { id: 'controller-session-1', accountId: 'user-1' },
        ];
        state.accessKeys = [
            { accountId: 'user-1', machineId: 'machine-1', sessionId: 'controller-session-1', updatedAt: new Date('2026-03-16T00:00:00.000Z') },
        ];
        state.onlineMachineIds = new Set(['machine-1']);
        state.dispatchReadyMachineIds = new Set(['machine-1']);
    };

    const matchesStatus = (value: string, where: any): boolean => {
        if (!where) {
            return true;
        }
        if (typeof where === 'string') {
            return value === where;
        }
        if (Array.isArray(where.in)) {
            return where.in.includes(value);
        }
        return true;
    };

    const matchesRun = (run: RunRecord, where: any): boolean => {
        if (!where) {
            return true;
        }
        if (where.id && run.id !== where.id) {
            return false;
        }
        if (where.accountId && run.accountId !== where.accountId) {
            return false;
        }
        if (typeof where.controllerSessionId === 'string' && run.controllerSessionId !== where.controllerSessionId) {
            return false;
        }
        if (where.controllerSessionId === null && run.controllerSessionId !== null) {
            return false;
        }
        if (where.idempotencyKey && run.idempotencyKey !== where.idempotencyKey) {
            return false;
        }
        if (where.status && !matchesStatus(run.status, where.status)) {
            return false;
        }
        if (Array.isArray(where.OR)) {
            const orMatched = where.OR.some((item: any) => {
                if (item.createdAt?.lt) {
                    return run.createdAt < item.createdAt.lt;
                }
                if (Array.isArray(item.AND)) {
                    return item.AND.every((andItem: any) => {
                        if (andItem.createdAt) {
                            return run.createdAt.getTime() === andItem.createdAt.getTime();
                        }
                        if (andItem.id?.lt) {
                            return run.id < andItem.id.lt;
                        }
                        return true;
                    });
                }
                return false;
            });
            if (!orMatched) {
                return false;
            }
        }
        return true;
    };

    const matchesTask = (task: TaskRecord, where: any): boolean => {
        if (!where) {
            return true;
        }
        if (where.id && task.id !== where.id) {
            return false;
        }
        if (where.runId && task.runId !== where.runId) {
            return false;
        }
        if (where.taskKey?.not === null && task.taskKey === null) {
            return false;
        }
        if (where.status && !matchesStatus(task.status, where.status)) {
            return false;
        }
        if (Array.isArray(where.OR)) {
            const orMatched = where.OR.some((item: any) => {
                if ('nextAttemptAt' in item) {
                    if (item.nextAttemptAt === null) {
                        return task.nextAttemptAt === null;
                    }
                    if (item.nextAttemptAt?.lte) {
                        return task.nextAttemptAt !== null && task.nextAttemptAt <= item.nextAttemptAt.lte;
                    }
                }
                return false;
            });
            if (!orMatched) {
                return false;
            }
        }
        return true;
    };

    const matchesExecution = (execution: ExecutionRecord, where: any): boolean => {
        if (!where) {
            return true;
        }
        if (where.id && execution.id !== where.id) {
            return false;
        }
        if (where.runId && execution.runId !== where.runId) {
            return false;
        }
        if (where.taskId && execution.taskId !== where.taskId) {
            return false;
        }
        if (where.childSessionId?.not === null && execution.childSessionId === null) {
            return false;
        }
        if (where.status && !matchesStatus(execution.status, where.status)) {
            return false;
        }
        if (where.createdAt?.lt && !(execution.createdAt < where.createdAt.lt)) {
            return false;
        }
        if (where.run?.accountId) {
            const run = state.runs.find((item) => item.id === execution.runId);
            if (!run || run.accountId !== where.run.accountId) {
                return false;
            }
        }
        return true;
    };

    const updateRun = (run: RunRecord, data: any) => {
        Object.assign(run, data, { updatedAt: nextDate() });
        return run;
    };

    const updateTask = (task: TaskRecord, data: any) => {
        Object.assign(task, data, { updatedAt: nextDate() });
        return task;
    };

    const updateExecution = (execution: ExecutionRecord, data: any) => {
        Object.assign(execution, data, { updatedAt: nextDate() });
        return execution;
    };

    const selectTask = (task: TaskRecord, select: any) => {
        const includeRun = !!select?.run;
        const includeExecutions = !!select?.executions;
        return {
            ...task,
            ...(includeRun
                ? {
                    run: (() => {
                        const run = state.runs.find((item) => item.id === task.runId);
                        if (!run) {
                            return null;
                        }
                        return {
                            id: run.id,
                            title: run.title,
                            status: run.status,
                            updatedAt: run.updatedAt,
                            accountId: run.accountId,
                        };
                    })(),
                }
                : {}),
            ...(includeExecutions
                ? {
                    executions: state.executions
                        .filter((item) => item.taskId === task.id)
                        .sort((a, b) => a.attempt - b.attempt)
                        .map((item) => ({ ...item })),
                }
                : {}),
        };
    };

    const selectRun = (run: RunRecord, select: any) => {
        const includeTasks = !!select?.tasks;
        const tasks = includeTasks
            ? state.tasks
                .filter((task) => task.runId === run.id)
                .sort((a, b) => a.seq - b.seq)
                .map((task) => selectTask(task, select.tasks?.select))
            : undefined;
        return {
            ...run,
            ...(includeTasks ? { tasks } : {}),
        };
    };

    const runApi = {
        create: vi.fn(async (args: any) => {
            const now = nextDate();
            const run: RunRecord = {
                id: `run-${state.runSeq++}`,
                accountId: args.data.accountId,
                title: args.data.title,
                status: args.data.status,
                maxConcurrency: args.data.maxConcurrency,
                controllerSessionId: args.data.controllerSessionId ?? null,
                idempotencyKey: args.data.idempotencyKey ?? null,
                metadata: args.data.metadata ?? null,
                createdAt: now,
                updatedAt: now,
                completedAt: null,
                cancelRequestedAt: null,
            };
            state.runs.push(run);
            return selectRun(run, args.select);
        }),
        findFirst: vi.fn(async (args: any) => {
            const run = state.runs.find((item) => matchesRun(item, args?.where));
            if (!run) {
                return null;
            }
            return selectRun(run, args?.select);
        }),
        findUnique: vi.fn(async (args: any) => {
            const run = state.runs.find((item) => item.id === args?.where?.id);
            if (!run) {
                return null;
            }
            return selectRun(run, args?.select);
        }),
        findMany: vi.fn(async (args: any) => {
            let rows = state.runs.filter((item) => matchesRun(item, args?.where));
            const orderBy = args?.orderBy;
            if (Array.isArray(orderBy)) {
                for (const order of orderBy.slice().reverse()) {
                    const [key, direction] = Object.entries(order)[0] as [keyof RunRecord, 'asc' | 'desc'];
                    rows = rows.sort((a, b) => {
                        const av = a[key] as any;
                        const bv = b[key] as any;
                        if (av < bv) {
                            return direction === 'asc' ? -1 : 1;
                        }
                        if (av > bv) {
                            return direction === 'asc' ? 1 : -1;
                        }
                        return 0;
                    });
                }
            } else if (orderBy) {
                const [key, direction] = Object.entries(orderBy)[0] as [keyof RunRecord, 'asc' | 'desc'];
                rows = rows.sort((a, b) => {
                    const av = a[key] as any;
                    const bv = b[key] as any;
                    if (av < bv) {
                        return direction === 'asc' ? -1 : 1;
                    }
                    if (av > bv) {
                        return direction === 'asc' ? 1 : -1;
                    }
                    return 0;
                });
            }
            if (typeof args?.take === 'number') {
                rows = rows.slice(0, args.take);
            }
            return rows.map((item) => selectRun(item, args?.select));
        }),
        update: vi.fn(async (args: any) => {
            const run = state.runs.find((item) => item.id === args?.where?.id);
            if (!run) {
                throw new Error('run not found');
            }
            updateRun(run, args?.data ?? {});
            return selectRun(run, args?.select);
        }),
        updateMany: vi.fn(async (args: any) => {
            const rows = state.runs.filter((item) => matchesRun(item, args?.where));
            for (const run of rows) {
                updateRun(run, args?.data ?? {});
            }
            return { count: rows.length };
        }),
    };

    const taskApi = {
        createMany: vi.fn(async (args: any) => {
            for (const data of args.data as any[]) {
                const now = nextDate();
                state.tasks.push({
                    id: `task-${state.taskSeq++}`,
                    runId: data.runId,
                    seq: data.seq,
                    taskKey: data.taskKey ?? null,
                    title: data.title ?? null,
                    provider: data.provider,
                    model: data.model ?? null,
                    prompt: data.prompt,
                    workingDirectory: data.workingDirectory ?? null,
                    timeoutMs: data.timeoutMs ?? null,
                    targetMachineId: data.targetMachineId ?? null,
                    dependsOnTaskKeys: data.dependsOnTaskKeys ?? [],
                    retryMaxAttempts: data.retryMaxAttempts ?? 1,
                    retryBackoffMs: data.retryBackoffMs ?? 0,
                    nextAttemptAt: data.nextAttemptAt ?? null,
                    status: data.status ?? 'queued',
                    outputSummary: null,
                    outputText: null,
                    errorCode: null,
                    errorMessage: null,
                    createdAt: now,
                    updatedAt: now,
                });
            }
            return { count: args.data.length };
        }),
        findUnique: vi.fn(async (args: any) => {
            const task = state.tasks.find((item) => item.id === args?.where?.id);
            if (!task) {
                return null;
            }
            return selectTask(task, args?.select);
        }),
        findFirst: vi.fn(async (args: any) => {
            let rows = state.tasks.filter((item) => matchesTask(item, args?.where));
            if (args?.where?.run?.accountId) {
                rows = rows.filter((task) => {
                    const run = state.runs.find((item) => item.id === task.runId);
                    return run?.accountId === args.where.run.accountId;
                });
            }
            const task = rows[0];
            if (!task) {
                return null;
            }
            return selectTask(task, args?.select);
        }),
        findMany: vi.fn(async (args: any) => {
            let rows = state.tasks.filter((item) => matchesTask(item, args?.where));
            if (args?.orderBy?.seq) {
                rows = rows.sort((a, b) => args.orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq);
            }
            if (typeof args?.take === 'number') {
                rows = rows.slice(0, args.take);
            }
            return rows.map((item) => selectTask(item, args?.select));
        }),
        updateMany: vi.fn(async (args: any) => {
            const rows = state.tasks.filter((item) => matchesTask(item, args?.where));
            for (const task of rows) {
                updateTask(task, args?.data ?? {});
            }
            return { count: rows.length };
        }),
        groupBy: vi.fn(async (args: any) => {
            const rows = state.tasks.filter((item) => matchesTask(item, args?.where));
            const by: string[] = args?.by ?? [];
            const map = new Map<string, { runId?: string; status?: string; count: number }>();
            for (const row of rows) {
                const keyParts = by.map((field) => String((row as any)[field]));
                const key = keyParts.join('|');
                const current = map.get(key) ?? {
                    ...(by.includes('runId') ? { runId: row.runId } : {}),
                    ...(by.includes('status') ? { status: row.status } : {}),
                    count: 0,
                };
                current.count += 1;
                map.set(key, current);
            }
            return [...map.values()].map((item) => ({
                ...(item.runId ? { runId: item.runId } : {}),
                ...(item.status ? { status: item.status } : {}),
                _count: { _all: item.count },
            }));
        }),
        count: vi.fn(async (args: any) => {
            let rows = state.tasks;
            if (args?.where?.status) {
                rows = rows.filter((item) => matchesStatus(item.status, args.where.status));
            }
            if (args?.where?.runId) {
                rows = rows.filter((item) => item.runId === args.where.runId);
            }
            return rows.length;
        }),
    };

    const executionApi = {
        create: vi.fn(async (args: any) => {
            const now = nextDate();
            const execution: ExecutionRecord = {
                id: `exec-${state.executionSeq++}`,
                runId: args.data.runId,
                taskId: args.data.taskId,
                machineId: args.data.machineId,
                provider: args.data.provider,
                model: args.data.model ?? null,
                childSessionId: args.data.childSessionId ?? null,
                executionType: args.data.executionType ?? 'initial',
                resumeMessage: args.data.resumeMessage ?? null,
                status: args.data.status,
                attempt: args.data.attempt ?? 1,
                dispatchToken: args.data.dispatchToken,
                timeoutMs: args.data.timeoutMs ?? null,
                pid: null,
                startedAt: null,
                finishedAt: null,
                exitCode: null,
                signal: null,
                outputSummary: null,
                outputText: null,
                errorCode: null,
                errorMessage: null,
                createdAt: now,
                updatedAt: now,
            };
            state.executions.push(execution);
            return { ...execution };
        }),
        findFirst: vi.fn(async (args: any) => {
            let rows = state.executions.filter((item) => matchesExecution(item, args?.where));
            if (args?.orderBy?.attempt) {
                rows = rows.sort((a, b) => (
                    args.orderBy.attempt === 'asc'
                        ? a.attempt - b.attempt
                        : b.attempt - a.attempt
                ));
            }
            const execution = rows[0];
            if (!execution) {
                return null;
            }
            const run = state.runs.find((item) => item.id === execution.runId)!;
            const task = state.tasks.find((item) => item.id === execution.taskId)!;
            return {
                ...execution,
                run: {
                    status: run.status,
                    accountId: run.accountId,
                },
                task: {
                    retryMaxAttempts: task.retryMaxAttempts,
                    retryBackoffMs: task.retryBackoffMs,
                },
            };
        }),
        findUnique: vi.fn(async (args: any) => {
            const execution = state.executions.find((item) => item.id === args?.where?.id);
            if (!execution) {
                return null;
            }
            return { ...execution };
        }),
        findMany: vi.fn(async (args: any) => {
            let rows = state.executions.filter((item) => matchesExecution(item, args?.where));
            if (args?.orderBy?.attempt) {
                rows = rows.sort((a, b) => (
                    args.orderBy.attempt === 'asc'
                        ? a.attempt - b.attempt
                        : b.attempt - a.attempt
                ));
            }
            return rows.map((item) => ({ ...item }));
        }),
        update: vi.fn(async (args: any) => {
            const execution = state.executions.find((item) => item.id === args?.where?.id);
            if (!execution) {
                throw new Error('execution not found');
            }
            updateExecution(execution, args?.data ?? {});
            return { ...execution };
        }),
        updateMany: vi.fn(async (args: any) => {
            const rows = state.executions.filter((item) => matchesExecution(item, args?.where));
            for (const row of rows) {
                updateExecution(row, args?.data ?? {});
            }
            return { count: rows.length };
        }),
        count: vi.fn(async (args: any) => {
            return state.executions.filter((item) => matchesExecution(item, args?.where)).length;
        }),
    };

    const machineApi = {
        findMany: vi.fn(async (args: any) => {
            let rows = state.machines.filter((item) => item.accountId === args?.where?.accountId);
            if (args?.where?.id?.in) {
                const allowed = new Set(args.where.id.in);
                rows = rows.filter((item) => allowed.has(item.id));
            }
            return rows.map((item) => ({ ...item }));
        }),
        findFirst: vi.fn(async (args: any) => {
            let rows = state.machines.filter((item) => item.accountId === args?.where?.accountId);
            if (typeof args?.where?.active === 'boolean') {
                rows = rows.filter((item) => item.active === args.where.active);
            }
            rows = rows.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
            return rows[0] ? { ...rows[0] } : null;
        }),
    };

    const sessionApi = {
        findFirst: vi.fn(async (args: any) => {
            const row = state.sessions.find((item) => (
                item.id === args?.where?.id &&
                item.accountId === args?.where?.accountId
            ));
            if (!row) {
                return null;
            }
            return { ...row };
        }),
    };

    const accessKeyApi = {
        findFirst: vi.fn(async (args: any) => {
            let rows = state.accessKeys.filter((item) =>
                item.sessionId === args?.where?.sessionId &&
                item.accountId === args?.where?.accountId,
            );
            if (args?.orderBy?.updatedAt === 'desc') {
                rows = rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
            }
            return rows[0] ? { machineId: rows[0].machineId } : null;
        }),
    };

    const tx = {
        orchestratorRun: runApi,
        orchestratorTask: taskApi,
        orchestratorExecution: executionApi,
        machine: machineApi,
        session: sessionApi,
        accessKey: accessKeyApi,
    };

    const dbMock = {
        orchestratorRun: runApi,
        orchestratorTask: taskApi,
        orchestratorExecution: executionApi,
        machine: machineApi,
        session: sessionApi,
        accessKey: accessKeyApi,
        $transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    const invokeUserRpcMock = vi.fn(async () => ({}));
    const listConnectedUserRpcMethodsMock = vi.fn((_userId: string) => {
        return Array.from(state.dispatchReadyMachineIds).map((machineId) => `${machineId}:orchestrator-dispatch`);
    });
    const eventRouterMock = {
        emitEphemeral: vi.fn(),
        getConnections: vi.fn((_userId: string) => {
            const connections = new Set<any>();
            for (const machineId of state.onlineMachineIds) {
                connections.add({
                    connectionType: 'machine-scoped',
                    machineId,
                    socket: {
                        connected: true,
                    },
                });
            }
            return connections;
        }),
    };

    return {
        state,
        resetState,
        dbMock,
        invokeUserRpcMock,
        listConnectedUserRpcMethodsMock,
        eventRouterMock,
    };
});

vi.mock('@/storage/db', () => ({
    db: dbMock,
}));

vi.mock('@/app/api/socket/rpcRegistry', () => ({
    invokeUserRpc: invokeUserRpcMock,
    listConnectedUserRpcMethods: listConnectedUserRpcMethodsMock,
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: eventRouterMock,
    buildOrchestratorActivityEphemeral: vi.fn((_sessionId: string, _running: number) => ({ type: 'orchestrator-activity' })),
}));

import { orchestratorRoutes } from '@/app/api/routes/orchestratorRoutes';
import { orchestratorSchedulerTick } from './scheduler';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        request.userId = userId;
    });

    orchestratorRoutes(typed);
    await typed.ready();
    return typed;
}

describe('orchestrator integration paths', () => {
    beforeEach(() => {
        resetState();
        invokeUserRpcMock.mockReset();
        listConnectedUserRpcMethodsMock.mockClear();
        eventRouterMock.getConnections.mockClear();
    });

    it('submit -> scheduler dispatch -> daemon start/finish -> run completed', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'integration-run',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'do work',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const submitBody = submit.json();
        const runId = submitBody.data.runId as string;

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user-1',
            'machine-1:orchestrator-dispatch',
            expect.objectContaining({
                runId,
            }),
            expect.any(Number),
        );
        expect(state.executions).toHaveLength(1);
        const execution = state.executions[0];

        const start = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${execution.id}/start`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: execution.dispatchToken,
            },
        });
        expect(start.statusCode).toBe(200);

        const finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${execution.id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: execution.dispatchToken,
                status: 'completed',
                outputSummary: 'done',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(finish.json().data.runStatus).toBe('completed');

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('completed');
        expect(runGet.json().data.summary).toEqual(
            expect.objectContaining({
                total: 1,
                completed: 1,
            }),
        );

        await app.close();
    });

    it('submit -> cancel -> run cancelled', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'cancel-run',
                tasks: [
                    {
                        provider: 'claude',
                        prompt: 'do work',
                    },
                ],
            },
        });
        const runId = submit.json().data.runId as string;

        const cancel = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/runs/${runId}/cancel`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                reason: 'stop',
            },
        });
        expect(cancel.statusCode).toBe(200);
        expect(cancel.json().data.status).toBe('cancelled');

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('cancelled');
        expect(runGet.json().data.summary).toEqual(
            expect.objectContaining({
                total: 1,
                cancelled: 1,
            }),
        );

        await app.close();
    });

    it('cancel with DAG marks downstream task as dependency_failed before response returns', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'cancel-dag-run',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'task a',
                    },
                    {
                        taskKey: 'task-b',
                        provider: 'codex',
                        prompt: 'task b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;

        const cancel = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/runs/${runId}/cancel`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                reason: 'stop',
            },
        });
        expect(cancel.statusCode).toBe(200);
        expect(cancel.json().data.status).toBe('cancelled');

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('cancelled');
        const tasks = runGet.json().data.tasks as Array<{ taskKey: string | null; status: string }>;
        const taskA = tasks.find((task) => task.taskKey === 'task-a');
        const taskB = tasks.find((task) => task.taskKey === 'task-b');
        expect(taskA?.status).toBe('cancelled');
        expect(taskB?.status).toBe('dependency_failed');
        expect(runGet.json().data.summary).toEqual(
            expect.objectContaining({
                total: 2,
                failed: 1,
                cancelled: 1,
            }),
        );

        await app.close();
    });

    it('submit -> dispatch rpc failure -> execution failed -> run failed', async () => {
        invokeUserRpcMock.mockRejectedValueOnce(new Error('machine offline'));

        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'offline-run',
                tasks: [
                    {
                        provider: 'gemini',
                        prompt: 'do work',
                    },
                ],
            },
        });
        const runId = submit.json().data.runId as string;

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));

        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].status).toBe('failed');
        expect(state.tasks[0].status).toBe('failed');

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('failed');
        expect(runGet.json().data.summary).toEqual(
            expect.objectContaining({
                total: 1,
                failed: 1,
            }),
        );

        await app.close();
    });

    it('rejects submit when dependency references unknown taskKey', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'dependency-invalid',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'work',
                        dependsOn: ['task-b'],
                    },
                ],
            },
        });

        expect(submit.statusCode).toBe(400);
        expect(submit.json().error.code).toBe('INVALID_DEPENDENCY');
        await app.close();
    });

    it('rejects submit when dependency graph has cycle', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'dependency-cycle',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'work-a',
                        dependsOn: ['task-b'],
                    },
                    {
                        taskKey: 'task-b',
                        provider: 'codex',
                        prompt: 'work-b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });

        expect(submit.statusCode).toBe(400);
        expect(submit.json().error.code).toBe('INVALID_DAG_CYCLE');
        await app.close();
    });

    it('rejects submit when task model does not match provider', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'invalid-task-model',
                tasks: [
                    {
                        provider: 'claude',
                        model: 'gpt-5.3-codex-high',
                        prompt: 'work',
                    },
                ],
            },
        });

        expect(submit.statusCode).toBe(400);
        expect(submit.json().error.code).toBe('INVALID_ARGUMENT');
        await app.close();
    });

    it('allows unknown model strings outside catalog and forwards as-is', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'unknown-task-model-forward',
                tasks: [
                    {
                        provider: 'claude',
                        model: 'claude-sonnet-4-6-20260315',
                        prompt: 'work',
                    },
                ],
            },
        });

        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;
        const createdTask = state.tasks.find((task) => task.runId === runId);
        expect(createdTask?.model).toBe('claude-sonnet-4-6-20260315');

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user-1',
            'machine-1:orchestrator-dispatch',
            expect.objectContaining({
                provider: 'claude',
                model: 'claude-sonnet-4-6-20260315',
            }),
            expect.any(Number),
        );
        await app.close();
    });

    it('normalizes default model and persists model in dispatch/execution/task responses', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'task-model-passthrough',
                tasks: [
                    {
                        provider: 'codex',
                        model: 'gpt-5.3-codex-high',
                        prompt: 'work-a',
                    },
                    {
                        provider: 'claude',
                        model: 'default',
                        prompt: 'work-b',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;

        const createdTasks = state.tasks.filter((task) => task.runId === runId).sort((a, b) => a.seq - b.seq);
        expect(createdTasks[0].model).toBe('gpt-5.3-codex-high');
        expect(createdTasks[1].model).toBeNull();

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));

        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user-1',
            'machine-1:orchestrator-dispatch',
            expect.objectContaining({
                provider: 'codex',
                model: 'gpt-5.3-codex-high',
            }),
            expect.any(Number),
        );
        expect(state.executions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                provider: 'codex',
                model: 'gpt-5.3-codex-high',
            }),
        ]));

        const getRun = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(getRun.statusCode).toBe(200);
        const responseTasks = getRun.json().data.tasks;
        expect(responseTasks[0].model).toBe('gpt-5.3-codex-high');
        expect(responseTasks[1].model).toBeNull();
        await app.close();
    });

    it('captures childSessionId on finish and supports resume send-message for terminal task', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'resume-task-message',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'initial prompt',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);
        const initialExecution = state.executions[0];
        expect(initialExecution.executionType).toBe('initial');
        expect(initialExecution.childSessionId).toBeNull();

        const finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${initialExecution.id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: initialExecution.dispatchToken,
                status: 'completed',
                childSessionId: '11111111-2222-4333-8444-555555555555',
                finishedAt: '2026-03-16T00:00:01.000Z',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(state.executions[0].childSessionId).toBe('11111111-2222-4333-8444-555555555555');

        const taskId = state.tasks[0].id;
        const sendMessage = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/tasks/${taskId}/send-message`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                message: 'follow up question',
            },
        });
        expect(sendMessage.statusCode).toBe(200);
        expect(state.tasks[0].status).toBe('queued');
        expect(state.executions).toHaveLength(2);
        expect(state.executions[1]).toEqual(expect.objectContaining({
            executionType: 'resume',
            childSessionId: '11111111-2222-4333-8444-555555555555',
            resumeMessage: 'follow up question',
            status: 'queued',
        }));

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:02.000Z'));
        expect(invokeUserRpcMock).toHaveBeenLastCalledWith(
            'user-1',
            'machine-1:orchestrator-dispatch',
            expect.objectContaining({
                executionType: 'resume',
                childSessionId: '11111111-2222-4333-8444-555555555555',
                prompt: 'follow up question',
            }),
            expect.any(Number),
        );
        await app.close();
    });

    it('rejects send-message when task has no captured childSessionId', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'resume-task-missing-child-session',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'initial prompt',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        const initialExecution = state.executions[0];
        const finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${initialExecution.id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: initialExecution.dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:01.000Z',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(state.executions[0].childSessionId).toBeNull();

        const taskId = state.tasks[0].id;
        const sendMessage = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/tasks/${taskId}/send-message`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                message: 'follow up question',
            },
        });
        expect(sendMessage.statusCode).toBe(409);
        expect(sendMessage.json().error.code).toBe('CONFLICT');
        await app.close();
    });

    it('rejects send-message when task is not in completed/failed terminal state', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'resume-task-invalid-state',
                tasks: [
                    {
                        provider: 'claude',
                        prompt: 'initial prompt',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        const taskId = state.tasks[0].id;
        const sendMessage = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/tasks/${taskId}/send-message`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                message: 'follow up question',
            },
        });
        expect(sendMessage.statusCode).toBe(409);
        expect(sendMessage.json().error.code).toBe('CONFLICT');
        await app.close();
    });

    it('allows task without taskKey to depend on keyed task and schedules in order', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'dependency-non-keyed-downstream',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'work-a',
                    },
                    {
                        provider: 'codex',
                        prompt: 'work-b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].provider).toBe('claude');

        const finishUpstream = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[0].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[0].dispatchToken,
                status: 'completed',
                finishedAt: '2026-03-16T00:00:01.000Z',
            },
        });
        expect(finishUpstream.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:02.000Z'));
        expect(state.executions).toHaveLength(2);
        expect(state.executions[1].provider).toBe('codex');
        await app.close();
    });

    it('returns orchestrator context with machine online and dispatch readiness', async () => {
        state.machines.push({
            id: 'machine-2',
            accountId: 'user-1',
            active: true,
            lastActiveAt: new Date('2026-03-16T00:00:01.000Z'),
        });
        state.onlineMachineIds = new Set(['machine-1']);
        state.dispatchReadyMachineIds = new Set(['machine-1']);

        const app = await createApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/orchestrator/context',
            headers: { 'x-user-id': 'user-1' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data.modelModes).toEqual({
            claude: CLAUDE_MODEL_MODES,
            codex: CODEX_MODEL_MODES,
            gemini: GEMINI_MODEL_MODES,
        });
        expect(body.data.defaults).toEqual(expect.objectContaining({
            retryMaxAttempts: 1,
            retryBackoffMs: 0,
        }));
        expect(body.data.machines).toEqual([
            expect.objectContaining({
                machineId: 'machine-1',
                online: true,
                dispatchReady: true,
            }),
            expect.objectContaining({
                machineId: 'machine-2',
                online: false,
                dispatchReady: false,
            }),
        ]);
        await app.close();
    });

    it('exposes dag/retry task fields in get and pend responses', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'response-task-fields',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'step a',
                    },
                    {
                        provider: 'codex',
                        prompt: 'step b',
                        dependsOn: ['task-a'],
                        retry: {
                            maxAttempts: 3,
                            backoffMs: 5000,
                        },
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;

        const getRun = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(getRun.statusCode).toBe(200);
        const getTasks = getRun.json().data.tasks;
        expect(getTasks[1]).toEqual(expect.objectContaining({
            dependsOn: ['task-a'],
            retry: {
                maxAttempts: 3,
                backoffMs: 5000,
            },
            nextAttemptAt: null,
        }));

        const pend = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}/pend?include=all_tasks&timeoutMs=0`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(pend.statusCode).toBe(200);
        const pendTasks = pend.json().data.tasks;
        expect(pendTasks[1]).toEqual(expect.objectContaining({
            dependsOn: ['task-a'],
            retry: {
                maxAttempts: 3,
                backoffMs: 5000,
            },
            nextAttemptAt: null,
        }));

        const listRuns = await app.inject({
            method: 'GET',
            url: '/v1/orchestrator/runs',
            headers: { 'x-user-id': 'user-1' },
        });
        expect(listRuns.statusCode).toBe(200);
        expect(listRuns.json().data.items[0]).toEqual(expect.objectContaining({
            runId,
            summary: expect.any(Object),
        }));
        await app.close();
    });

    it('returns single-task detail with optional execution history', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'single-task-detail',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'step a',
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;
        const taskId = state.tasks.find((task) => task.runId === runId)!.id;

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));

        const response = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}/tasks/${taskId}?includeExecutions=true`,
            headers: { 'x-user-id': 'user-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data).toEqual(expect.objectContaining({
            run: expect.objectContaining({
                runId,
                title: 'single-task-detail',
            }),
            task: expect.objectContaining({
                taskId,
                executions: [
                    expect.objectContaining({
                        attempt: 1,
                        status: 'dispatching',
                    }),
                ],
            }),
        }));
        await app.close();
    });

    it('filters run list by controllerSessionId', async () => {
        const app = await createApp();
        state.sessions.push({ id: 'controller-session-2', accountId: 'user-1' });

        const firstSubmit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'run-from-session-1',
                controllerSessionId: 'controller-session-1',
                tasks: [
                    {
                        provider: 'claude',
                        prompt: 'step a',
                    },
                ],
            },
        });
        expect(firstSubmit.statusCode).toBe(200);

        const secondSubmit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'run-from-session-2',
                controllerSessionId: 'controller-session-2',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'step b',
                    },
                ],
            },
        });
        expect(secondSubmit.statusCode).toBe(200);

        const thirdSubmit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'run-without-session',
                tasks: [
                    {
                        provider: 'gemini',
                        prompt: 'step c',
                    },
                ],
            },
        });
        expect(thirdSubmit.statusCode).toBe(200);

        const response = await app.inject({
            method: 'GET',
            url: '/v1/orchestrator/runs?controllerSessionId=controller-session-1',
            headers: { 'x-user-id': 'user-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.items).toEqual([
            expect.objectContaining({
                title: 'run-from-session-1',
            }),
        ]);
        await app.close();
    });

    it('marks downstream queued tasks as dependency_failed when dependency task fails', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'dependency-failed-propagation',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'do task a',
                    },
                    {
                        taskKey: 'task-b',
                        provider: 'codex',
                        prompt: 'do task b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);
        const execution = state.executions[0];

        const finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${execution.id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: execution.dispatchToken,
                status: 'failed',
                errorCode: 'UPSTREAM_FAIL',
                errorMessage: 'task a failed',
            },
        });
        expect(finish.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:05.000Z'));

        const downstreamTask = state.tasks.find((task) => task.taskKey === 'task-b');
        expect(downstreamTask?.status).toBe('dependency_failed');
        expect(downstreamTask?.errorCode).toBe('DEPENDENCY_FAILED');

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('failed');
        await app.close();
    });

    it('retries failed task with fixed backoff until max attempts', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'retry-fixed-backoff',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'codex',
                        prompt: 'retry me',
                        retry: {
                            maxAttempts: 3,
                            backoffMs: 5000,
                        },
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);
        const runId = submit.json().data.runId as string;

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].attempt).toBe(1);

        let finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[0].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[0].dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:00.000Z',
                errorCode: 'ATTEMPT_1_FAILED',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(state.tasks[0].status).toBe('queued');
        expect(state.tasks[0].nextAttemptAt?.toISOString()).toBe('2026-03-16T00:00:05.000Z');

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:03.000Z'));
        expect(state.executions).toHaveLength(1);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:05.000Z'));
        expect(state.executions).toHaveLength(2);
        expect(state.executions[1].attempt).toBe(2);

        finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[1].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[1].dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:05.000Z',
                errorCode: 'ATTEMPT_2_FAILED',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(state.tasks[0].status).toBe('queued');
        expect(state.tasks[0].nextAttemptAt?.toISOString()).toBe('2026-03-16T00:00:10.000Z');

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:09.000Z'));
        expect(state.executions).toHaveLength(2);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:10.000Z'));
        expect(state.executions).toHaveLength(3);
        expect(state.executions[2].attempt).toBe(3);

        finish = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[2].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[2].dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:10.000Z',
                errorCode: 'ATTEMPT_3_FAILED',
            },
        });
        expect(finish.statusCode).toBe(200);
        expect(state.tasks[0].status).toBe('failed');
        expect(state.tasks[0].nextAttemptAt).toBeNull();

        const runGet = await app.inject({
            method: 'GET',
            url: `/v1/orchestrator/runs/${runId}`,
            headers: { 'x-user-id': 'user-1' },
        });
        expect(runGet.statusCode).toBe(200);
        expect(runGet.json().data.status).toBe('failed');
        await app.close();
    });

    it('does not mark downstream dependency_failed while upstream is queued for retry', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'retry-dag-linkage',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'task a',
                        retry: {
                            maxAttempts: 2,
                            backoffMs: 5000,
                        },
                    },
                    {
                        taskKey: 'task-b',
                        provider: 'codex',
                        prompt: 'task b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);

        const firstFail = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[0].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[0].dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:00.000Z',
            },
        });
        expect(firstFail.statusCode).toBe(200);
        expect(state.tasks.find((task) => task.taskKey === 'task-a')?.status).toBe('queued');

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:01.000Z'));
        expect(state.tasks.find((task) => task.taskKey === 'task-b')?.status).toBe('queued');

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:05.000Z'));
        expect(state.executions).toHaveLength(2);

        const secondFail = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[1].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[1].dispatchToken,
                status: 'failed',
                finishedAt: '2026-03-16T00:00:05.000Z',
            },
        });
        expect(secondFail.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:06.000Z'));
        expect(state.tasks.find((task) => task.taskKey === 'task-b')?.status).toBe('dependency_failed');
        await app.close();
    });

    it('dispatches task to explicit target machine_id', async () => {
        state.machines.push({
            id: 'machine-2',
            accountId: 'user-1',
            active: true,
            lastActiveAt: new Date('2026-03-16T00:00:02.000Z'),
        });

        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'target-machine',
                tasks: [
                    {
                        provider: 'gemini',
                        prompt: 'run on machine 2',
                        workingDirectory: '/workspace/repo-a',
                        target: {
                            type: 'machine_id',
                            machineId: 'machine-2',
                        },
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user-1',
            'machine-2:orchestrator-dispatch',
            expect.objectContaining({
                provider: 'gemini',
                workingDirectory: '/workspace/repo-a',
            }),
            expect.any(Number),
        );
        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].machineId).toBe('machine-2');
        await app.close();
    });

    it('resolves current_machine target to controller session machine via AccessKey', async () => {
        state.machines.push({
            id: 'machine-2',
            accountId: 'user-1',
            active: true,
            lastActiveAt: new Date('2026-03-16T00:00:02.000Z'),
        });
        state.onlineMachineIds.add('machine-2');
        state.dispatchReadyMachineIds.add('machine-2');
        state.sessions.push({ id: 'session-on-m2', accountId: 'user-1' });
        state.accessKeys.push({
            accountId: 'user-1',
            machineId: 'machine-2',
            sessionId: 'session-on-m2',
            updatedAt: new Date('2026-03-16T00:00:02.000Z'),
        });

        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'current-machine-resolve',
                controllerSessionId: 'session-on-m2',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'run on current machine',
                        workingDirectory: '/workspace/repo-b',
                        target: { type: 'current_machine' },
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:03.000Z'));
        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user-1',
            'machine-2:orchestrator-dispatch',
            expect.objectContaining({
                provider: 'codex',
                workingDirectory: '/workspace/repo-b',
            }),
            expect.any(Number),
        );
        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].machineId).toBe('machine-2');
        const task = state.tasks.find((t) => t.prompt === 'run on current machine');
        expect(task?.targetMachineId).toBe('machine-2');
        await app.close();
    });

    it('keeps core API strict and rejects target type "machine" alias', async () => {
        state.machines.push({
            id: 'machine-2',
            accountId: 'user-1',
            active: true,
            lastActiveAt: new Date('2026-03-16T00:00:02.000Z'),
        });

        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'target-machine-alias',
                tasks: [
                    {
                        provider: 'codex',
                        prompt: 'run on machine 2 by alias',
                        target: {
                            type: 'machine',
                            machineId: 'machine-2',
                        },
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(400);
        await app.close();
    });

    it('dispatches dependent task only after upstream dependency completed', async () => {
        const app = await createApp();
        const submit = await app.inject({
            method: 'POST',
            url: '/v1/orchestrator/submit',
            headers: { 'x-user-id': 'user-1' },
            payload: {
                title: 'dag-sequence',
                tasks: [
                    {
                        taskKey: 'task-a',
                        provider: 'claude',
                        prompt: 'step a',
                    },
                    {
                        taskKey: 'task-b',
                        provider: 'codex',
                        prompt: 'step b',
                        dependsOn: ['task-a'],
                    },
                ],
            },
        });
        expect(submit.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));
        expect(state.executions).toHaveLength(1);
        expect(state.executions[0].provider).toBe('claude');

        const finishUpstream = await app.inject({
            method: 'POST',
            url: `/v1/orchestrator/executions/${state.executions[0].id}/finish`,
            headers: { 'x-user-id': 'user-1' },
            payload: {
                dispatchToken: state.executions[0].dispatchToken,
                status: 'completed',
                finishedAt: '2026-03-16T00:00:01.000Z',
            },
        });
        expect(finishUpstream.statusCode).toBe(200);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:02.000Z'));
        expect(state.executions).toHaveLength(2);
        expect(state.executions[1].provider).toBe('codex');
        await app.close();
    });
});

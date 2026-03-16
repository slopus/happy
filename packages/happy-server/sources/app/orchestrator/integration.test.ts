import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '@/app/api/types';

type RunStatus = 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled';
type TaskStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled';
type ExecutionStatus = 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

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
    prompt: string;
    timeoutMs: number | null;
    targetMachineId: string | null;
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
        if (where.status && !matchesStatus(task.status, where.status)) {
            return false;
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

    const selectRun = (run: RunRecord, select: any) => {
        const includeTasks = !!select?.tasks;
        const tasks = includeTasks
            ? state.tasks
                .filter((task) => task.runId === run.id)
                .sort((a, b) => a.seq - b.seq)
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
                    prompt: data.prompt,
                    timeoutMs: data.timeoutMs ?? null,
                    targetMachineId: data.targetMachineId ?? null,
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
        findMany: vi.fn(async (args: any) => {
            let rows = state.tasks.filter((item) => matchesTask(item, args?.where));
            if (args?.orderBy?.seq) {
                rows = rows.sort((a, b) => args.orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq);
            }
            if (typeof args?.take === 'number') {
                rows = rows.slice(0, args.take);
            }
            return rows.map((item) => ({ ...item }));
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
            const execution = state.executions.find((item) => matchesExecution(item, args?.where));
            if (!execution) {
                return null;
            }
            const run = state.runs.find((item) => item.id === execution.runId)!;
            return {
                ...execution,
                run: {
                    status: run.status,
                    accountId: run.accountId,
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
            return state.executions.filter((item) => matchesExecution(item, args?.where)).map((item) => ({ ...item }));
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

    const tx = {
        orchestratorRun: runApi,
        orchestratorTask: taskApi,
        orchestratorExecution: executionApi,
        machine: machineApi,
        session: sessionApi,
    };

    const dbMock = {
        orchestratorRun: runApi,
        orchestratorTask: taskApi,
        orchestratorExecution: executionApi,
        machine: machineApi,
        session: sessionApi,
        $transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    const invokeUserRpcMock = vi.fn(async () => ({}));

    return {
        state,
        resetState,
        dbMock,
        invokeUserRpcMock,
    };
});

vi.mock('@/storage/db', () => ({
    db: dbMock,
}));

vi.mock('@/app/api/socket/rpcRegistry', () => ({
    invokeUserRpc: invokeUserRpcMock,
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
});

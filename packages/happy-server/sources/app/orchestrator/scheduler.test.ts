import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    state,
    invokeUserRpcMock,
    dbMock,
    resetState,
} = vi.hoisted(() => {
    const state = {
        runStatus: 'running',
        taskStatus: 'dispatching',
        executionStatus: 'dispatching',
    };

    const resetState = () => {
        state.runStatus = 'running';
        state.taskStatus = 'dispatching';
        state.executionStatus = 'dispatching';
    };

    const invokeUserRpcMock = vi.fn(async () => ({}));

    const dbMock = {
        orchestratorRun: {
            findMany: vi.fn(async () => []),
        },
        $transaction: vi.fn(async (fn: any) => {
            const tx = {
                orchestratorExecution: {
                    findUnique: vi.fn(async () => ({
                        id: 'exec_1',
                        status: state.executionStatus,
                        runId: 'run_1',
                        taskId: 'task_1',
                    })),
                    update: vi.fn(async (args: any) => {
                        state.executionStatus = args.data.status;
                        return { id: 'exec_1' };
                    }),
                },
                orchestratorTask: {
                    updateMany: vi.fn(async (args: any) => {
                        if (state.taskStatus !== args.where.status) {
                            return { count: 0 };
                        }
                        state.taskStatus = args.data.status;
                        return { count: 1 };
                    }),
                    groupBy: vi.fn(async () => [
                        { status: state.taskStatus, _count: { _all: 1 } },
                    ]),
                },
                orchestratorRun: {
                    findUnique: vi.fn(async () => ({
                        id: 'run_1',
                        status: state.runStatus,
                    })),
                    update: vi.fn(async (args: any) => {
                        state.runStatus = args.data.status;
                        return { id: 'run_1', status: state.runStatus };
                    }),
                },
            };
            return fn(tx);
        }),
    };

    return {
        state,
        invokeUserRpcMock,
        dbMock,
        resetState,
    };
});

vi.mock('@/storage/db', () => ({
    db: dbMock,
}));

vi.mock('@/app/api/socket/rpcRegistry', () => ({
    invokeUserRpc: invokeUserRpcMock,
}));

import { executeSchedulerActions, type SchedulerAction } from './scheduler';
import { orchestratorSchedulerTick } from './scheduler';

describe('orchestrator scheduler actions', () => {
    beforeEach(() => {
        resetState();
        invokeUserRpcMock.mockClear();
        dbMock.$transaction.mockClear();
        dbMock.orchestratorRun.findMany.mockClear();
    });

    it('dispatches action via invokeUserRpc', async () => {
        const actions: SchedulerAction[] = [
            {
                type: 'dispatch',
                accountId: 'user_1',
                machineId: 'machine_1',
                executionId: 'exec_1',
                runId: 'run_1',
                taskId: 'task_1',
                dispatchToken: 'token_1',
                payload: {
                    executionId: 'exec_1',
                    runId: 'run_1',
                    taskId: 'task_1',
                    dispatchToken: 'token_1',
                    provider: 'codex',
                    prompt: 'hello',
                    timeoutMs: 1000,
                },
            },
        ];

        await executeSchedulerActions(actions);

        expect(invokeUserRpcMock).toHaveBeenCalledWith(
            'user_1',
            'machine_1:orchestrator-dispatch',
            expect.objectContaining({ executionId: 'exec_1' }),
            expect.any(Number),
        );
        expect(dbMock.$transaction).not.toHaveBeenCalled();
    });

    it('marks task/execution failed when dispatch rpc fails', async () => {
        invokeUserRpcMock.mockRejectedValueOnce(new Error('RPC method not available'));

        const actions: SchedulerAction[] = [
            {
                type: 'dispatch',
                accountId: 'user_1',
                machineId: 'machine_1',
                executionId: 'exec_1',
                runId: 'run_1',
                taskId: 'task_1',
                dispatchToken: 'token_1',
                payload: {
                    executionId: 'exec_1',
                    runId: 'run_1',
                    taskId: 'task_1',
                    dispatchToken: 'token_1',
                    provider: 'claude',
                    prompt: 'hello',
                    timeoutMs: 1000,
                },
            },
        ];

        await executeSchedulerActions(actions);

        expect(state.executionStatus).toBe('failed');
        expect(state.taskStatus).toBe('failed');
        expect(state.runStatus).toBe('failed');
        expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it('scheduler tick exits quietly when there are no active runs', async () => {
        dbMock.orchestratorRun.findMany.mockResolvedValueOnce([]);

        await orchestratorSchedulerTick(new Date('2026-03-16T00:00:00.000Z'));

        expect(dbMock.orchestratorRun.findMany).toHaveBeenCalledTimes(1);
        expect(invokeUserRpcMock).not.toHaveBeenCalled();
    });
});

import { describe, expect, it, vi } from 'vitest';

import {
    codexGoalCommandRequiresExistingThread,
    consumeCodexGoalCommandText,
    createCodexGoalMutationQueue,
    executeCodexGoalCommand,
} from './codexGoalCommandHandler';

function goal(status: 'active' | 'paused') {
    return {
        threadId: 'thread-1',
        objective: 'ship the release',
        status,
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 5,
        createdAt: 1,
        updatedAt: 2,
    } as const;
}

describe('executeCodexGoalCommand', () => {
    it.each([
        ['paused', 'Goal paused'],
        ['active', 'Goal resumed'],
    ] as const)('sets only goal status to %s without replacing the objective', async (status, statusMessage) => {
        const setGoal = vi.fn().mockResolvedValue({ goal: goal(status) });
        const publishEvent = vi.fn();
        const reportStatus = vi.fn();

        await executeCodexGoalCommand({
            client: {
                supportsGoalActions: () => true,
                setGoal,
                clearGoal: vi.fn(),
            },
            command: { type: 'set-status', status },
            threadId: 'thread-1',
            publishEvent,
            reportStatus,
        });

        expect(setGoal).toHaveBeenCalledWith({
            threadId: 'thread-1',
            status,
        });
        expect(setGoal.mock.calls[0]?.[0]).not.toHaveProperty('objective');
        expect(publishEvent).toHaveBeenCalledWith({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: goal(status),
        });
        expect(reportStatus).toHaveBeenCalledWith(statusMessage);
    });

    it('rejects unsupported goal actions before sending any app-server request', async () => {
        const setGoal = vi.fn();
        const clearGoal = vi.fn();

        await expect(executeCodexGoalCommand({
            client: {
                supportsGoalActions: () => false,
                setGoal,
                clearGoal,
            },
            command: { type: 'set-status', status: 'active' },
            threadId: 'thread-1',
            publishEvent: vi.fn(),
            reportStatus: vi.fn(),
        })).rejects.toThrow('Codex CLI 0.140.0 or newer');
        expect(setGoal).not.toHaveBeenCalled();
        expect(clearGoal).not.toHaveBeenCalled();
    });
});

describe('consumeCodexGoalCommandText', () => {
    it('consumes a failed /goal action instead of falling through to a normal prompt', async () => {
        const failure = new Error('goal unavailable');
        const execute = vi.fn().mockRejectedValue(failure);
        const onError = vi.fn();

        await expect(consumeCodexGoalCommandText({
            text: '/goal resume',
            execute,
            onError,
        })).resolves.toBe(true);
        expect(execute).toHaveBeenCalledWith({ type: 'set-status', status: 'active' });
        expect(onError).toHaveBeenCalledWith(failure);
    });

    it('does not consume ordinary prompts', async () => {
        const execute = vi.fn();
        const onError = vi.fn();

        await expect(consumeCodexGoalCommandText({
            text: 'please resume the migration',
            execute,
            onError,
        })).resolves.toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });
});

describe('codexGoalCommandRequiresExistingThread', () => {
    it('allows only a new objective to create a Codex thread', () => {
        expect(codexGoalCommandRequiresExistingThread({ type: 'set', objective: 'new goal' })).toBe(false);
        expect(codexGoalCommandRequiresExistingThread({ type: 'set-status', status: 'paused' })).toBe(true);
        expect(codexGoalCommandRequiresExistingThread({ type: 'set-status', status: 'active' })).toBe(true);
        expect(codexGoalCommandRequiresExistingThread({ type: 'edit' })).toBe(true);
        expect(codexGoalCommandRequiresExistingThread({ type: 'clear' })).toBe(true);
    });
});

describe('createCodexGoalMutationQueue', () => {
    it('serializes explicit target-state mutations and continues after failures', async () => {
        const currentContext = { threadId: 'thread-1', threadEpoch: 1 };
        const enqueue = createCodexGoalMutationQueue(() => currentContext);
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = enqueue(currentContext, async () => {
            events.push('pause:start');
            await firstGate;
            events.push('pause:end');
            throw new Error('pause failed');
        });
        const second = enqueue(currentContext, async () => {
            events.push('resume:start');
            events.push('resume:end');
            return 'resumed';
        });

        await Promise.resolve();
        expect(events).toEqual(['pause:start']);
        releaseFirst();
        await expect(first).rejects.toThrow('pause failed');
        await expect(second).resolves.toBe('resumed');
        expect(events).toEqual([
            'pause:start',
            'pause:end',
            'resume:start',
            'resume:end',
        ]);
    });

    it('rejects a queued mutation when its captured thread epoch is stale', async () => {
        const currentContext: { threadId: string | null; threadEpoch: number } = {
            threadId: 'thread-1',
            threadEpoch: 1,
        };
        const enqueue = createCodexGoalMutationQueue(() => currentContext);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const staleOperation = vi.fn();

        const first = enqueue({ threadId: 'thread-1', threadEpoch: 1 }, async () => {
            await firstGate;
        });
        const stale = enqueue({ threadId: 'thread-1', threadEpoch: 1 }, staleOperation);

        await Promise.resolve();
        currentContext.threadId = 'thread-2';
        currentContext.threadEpoch = 2;
        releaseFirst();
        await expect(first).resolves.toBeUndefined();
        await expect(stale).rejects.toThrow('active thread changed');
        expect(staleOperation).not.toHaveBeenCalled();
    });

    it('does not publish an in-flight provider response after the thread changes', async () => {
        const currentContext: { threadId: string | null; threadEpoch: number } = {
            threadId: 'thread-1',
            threadEpoch: 1,
        };
        const enqueue = createCodexGoalMutationQueue(() => currentContext);
        let resolveSetGoal!: (result: { goal: ReturnType<typeof goal> }) => void;
        const setGoal = vi.fn(() => new Promise<{ goal: ReturnType<typeof goal> }>((resolve) => {
            resolveSetGoal = resolve;
        }));
        const publishEvent = vi.fn();
        const reportStatus = vi.fn();

        const mutation = enqueue(
            { threadId: 'thread-1', threadEpoch: 1 },
            (assertCurrent) => executeCodexGoalCommand({
                client: {
                    supportsGoalActions: () => true,
                    setGoal,
                    clearGoal: vi.fn(),
                },
                command: { type: 'set-status', status: 'paused' },
                threadId: 'thread-1',
                publishEvent,
                reportStatus,
                assertCurrent,
            }),
        );

        await Promise.resolve();
        expect(setGoal).toHaveBeenCalledTimes(1);
        currentContext.threadId = null;
        currentContext.threadEpoch = 2;
        resolveSetGoal({ goal: goal('paused') });

        await expect(mutation).rejects.toThrow('active thread changed');
        expect(publishEvent).not.toHaveBeenCalled();
        expect(reportStatus).not.toHaveBeenCalled();
    });
});

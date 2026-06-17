import { describe, expect, it, vi } from 'vitest';
import { mapCodexGoalEventToAgentGoalStatus, parseCodexGoalCommand } from './codexGoalStatus';

describe('mapCodexGoalEventToAgentGoalStatus', () => {
    it('maps an active Codex goal update into agent goal status', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T10:00:00.000Z'));

        const status = mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: {
                threadId: 'thread-1',
                objective: 'finish the release',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 42,
                timeUsedSeconds: 7,
                createdAt: 1781680000,
                updatedAt: 1781680007,
            },
        }, 'thread-1');

        expect(status).toEqual({
            source: 'codex',
            observedAt: Date.now(),
            sourceSessionId: 'thread-1',
            sourceRevision: 1781680007,
            status: 'active',
            text: 'finish the release',
        });

        vi.useRealTimers();
    });

    it('adds explicit capabilities only when the adapter reports support', () => {
        const status = mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: {
                threadId: 'thread-1',
                objective: 'finish the release',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 42,
                timeUsedSeconds: 7,
                createdAt: 1781680000,
                updatedAt: 1781680007,
            },
        }, 'thread-1', { capabilities: { clear: true } });

        expect(status).toMatchObject({
            status: 'active',
            capabilities: { clear: true },
        });
    });

    it('keeps paused and limited Codex goal states visible as current goals', () => {
        for (const codexStatus of ['paused', 'blocked', 'usageLimited', 'budgetLimited']) {
            const status = mapCodexGoalEventToAgentGoalStatus({
                type: 'thread_goal_updated',
                threadId: 'thread-1',
                goal: {
                    threadId: 'thread-1',
                    objective: `goal ${codexStatus}`,
                    status: codexStatus,
                    tokenBudget: 100,
                    tokensUsed: 50,
                    timeUsedSeconds: 10,
                    createdAt: 1,
                    updatedAt: 2,
                },
            }, 'thread-1');

            expect(status).toMatchObject({
                source: 'codex',
                sourceSessionId: 'thread-1',
                status: 'active',
                text: `goal ${codexStatus}`,
            });
        }
    });

    it('maps complete and cleared goals to inactive states', () => {
        expect(mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: {
                threadId: 'thread-1',
                objective: 'done',
                status: 'complete',
                tokenBudget: null,
                tokensUsed: 12,
                timeUsedSeconds: 3,
                createdAt: 1,
                updatedAt: 2,
            },
        }, 'thread-1')).toMatchObject({
            status: 'inactive',
            reason: 'completed',
            sourceSessionId: 'thread-1',
            sourceRevision: 2,
        });

        expect(mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_cleared',
            threadId: 'thread-1',
        }, 'thread-1')).toMatchObject({
            status: 'inactive',
            reason: 'cleared',
            sourceSessionId: 'thread-1',
        });
    });

    it('rejects malformed goal updates as unavailable', () => {
        expect(mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: {
                threadId: 'thread-1',
                objective: '   ',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2,
            },
        }, 'thread-1')).toMatchObject({
            status: 'unavailable',
            reason: 'malformed',
            sourceSessionId: 'thread-1',
        });
    });

    it('ignores goal events for a different Codex thread', () => {
        expect(mapCodexGoalEventToAgentGoalStatus({
            type: 'thread_goal_updated',
            threadId: 'old-thread',
            goal: {
                threadId: 'old-thread',
                objective: 'old goal',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2,
            },
        }, 'current-thread')).toBeNull();
    });

    it('does not derive goal state from user /goal text', () => {
        expect(mapCodexGoalEventToAgentGoalStatus({
            type: 'user_message',
            message: '/goal finish the release',
            threadId: 'thread-1',
        }, 'thread-1')).toBeNull();
    });
});

describe('parseCodexGoalCommand', () => {
    it('parses explicit Codex goal commands', () => {
        expect(parseCodexGoalCommand('/goal finish the release')).toEqual({
            type: 'set',
            objective: 'finish the release',
        });
        expect(parseCodexGoalCommand('  /goal   clear  ')).toEqual({
            type: 'clear',
        });
    });

    it('ignores empty goal commands and ordinary text', () => {
        expect(parseCodexGoalCommand('/goal')).toBeNull();
        expect(parseCodexGoalCommand('please /goal finish the release')).toBeNull();
    });
});

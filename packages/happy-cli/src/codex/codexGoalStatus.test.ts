import { describe, expect, it, vi } from 'vitest';
import {
    codexGoalActionCapabilities,
    codexGoalActionCapabilitiesV2,
    createCodexGoalInvalidationProjection,
    getCodexGoalEventThreadId,
    mapCodexGoalEventToAgentGoalStatus,
    mapCodexGoalEventToAgentGoalStatusV2,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    reduceCodexGoalProjection,
    shouldApplyCodexGoalStatusV2,
} from './codexGoalStatus';

function goalProjection(
    providerStatus: 'active' | 'paused',
    sourceRevision: number,
    threadId = 'thread-1',
) {
    const event = {
        type: 'thread_goal_updated',
        threadId,
        goal: {
            threadId,
            objective: 'finish the release',
            status: providerStatus,
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 7,
            createdAt: 1,
            updatedAt: sourceRevision,
        },
    };
    return {
        legacy: mapCodexGoalEventToAgentGoalStatus(event, threadId)!,
        detailed: mapCodexGoalEventToAgentGoalStatusV2(event, threadId)!,
    };
}

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

    it('exposes editable Codex goals when runtime goal actions are supported', () => {
        expect(codexGoalActionCapabilities(true)).toEqual({
            clear: true,
            edit: true,
        });
        expect(codexGoalActionCapabilities(false)).toBeUndefined();
    });

    it('keeps V1 capabilities stable while V2 exposes state-specific pause and resume actions', () => {
        expect(codexGoalActionCapabilitiesV2(true, 'active')).toEqual({
            clear: true,
            edit: true,
            pause: true,
        });
        expect(codexGoalActionCapabilitiesV2(true, 'paused')).toEqual({
            clear: true,
            edit: true,
            resume: true,
        });
        expect(codexGoalActionCapabilitiesV2(true, 'blocked')).toEqual({
            clear: true,
            edit: true,
        });
        expect(codexGoalActionCapabilitiesV2(false, 'active')).toBeUndefined();
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

describe('mapCodexGoalEventToAgentGoalStatusV2', () => {
    it('preserves the provider status and publishes pause/resume capabilities', () => {
        const active = mapCodexGoalEventToAgentGoalStatusV2({
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
        }, 'thread-1', { actionsSupported: true });
        const paused = mapCodexGoalEventToAgentGoalStatusV2({
            type: 'thread_goal_updated',
            threadId: 'thread-1',
            goal: {
                threadId: 'thread-1',
                objective: 'finish the release',
                status: 'paused',
                tokenBudget: null,
                tokensUsed: 42,
                timeUsedSeconds: 7,
                createdAt: 1781680000,
                updatedAt: 1781680008,
            },
        }, 'thread-1', { actionsSupported: true });

        expect(active).toMatchObject({
            version: 2,
            status: 'active',
            providerStatus: 'active',
            capabilities: { clear: true, edit: true, pause: true },
        });
        expect(paused).toMatchObject({
            version: 2,
            status: 'active',
            providerStatus: 'paused',
            capabilities: { clear: true, edit: true, resume: true },
        });
    });

    it('deduplicates equal revisions and rejects stale goal snapshots', () => {
        const current = {
            version: 2 as const,
            source: 'codex' as const,
            observedAt: 10,
            sourceSessionId: 'thread-1',
            sourceRevision: 5,
            status: 'active' as const,
            text: 'current goal',
            providerStatus: 'active' as const,
        };

        expect(shouldApplyCodexGoalStatusV2(current, {
            ...current,
            observedAt: 11,
        })).toBe(false);
        expect(shouldApplyCodexGoalStatusV2(current, {
            ...current,
            observedAt: 12,
            sourceRevision: 4,
            text: 'stale goal',
        })).toBe(false);
        expect(shouldApplyCodexGoalStatusV2(current, {
            ...current,
            observedAt: 13,
            providerStatus: 'paused',
        })).toBe(true);
        expect(shouldApplyCodexGoalStatusV2(current, {
            ...current,
            observedAt: 14,
            sourceRevision: 6,
            providerStatus: 'paused',
        })).toBe(true);
    });

    it('does not let an older async persisted snapshot roll back the latest projection', () => {
        const revisionTen = goalProjection('active', 10);
        const sameRevisionChanged = goalProjection('paused', 10);
        const revisionNine = goalProjection('paused', 9);
        const revisionEleven = goalProjection('paused', 11);

        expect(reduceCodexGoalProjection(revisionTen, sameRevisionChanged, 'event')).toBe(sameRevisionChanged);
        expect(reduceCodexGoalProjection(revisionTen, sameRevisionChanged, 'persisted')).toBe(revisionTen);
        expect(reduceCodexGoalProjection(revisionTen, revisionNine, 'persisted')).toBe(revisionTen);
        expect(reduceCodexGoalProjection(revisionTen, revisionEleven, 'persisted')).toBe(revisionEleven);
        expect(reduceCodexGoalProjection(
            revisionTen,
            goalProjection('paused', 12, 'old-thread'),
            'persisted',
        )).toBe(revisionTen);
    });

    it('creates explicit V1/V2 invalidations for thread replacement and reset', () => {
        const projection = createCodexGoalInvalidationProjection({
            sourceSessionId: 'thread-1',
            observedAt: 123,
            state: { status: 'unavailable', reason: 'error' },
        });

        expect(projection).toEqual({
            legacy: {
                source: 'codex',
                observedAt: 123,
                sourceSessionId: 'thread-1',
                status: 'unavailable',
                reason: 'error',
            },
            detailed: {
                version: 2,
                source: 'codex',
                observedAt: 123,
                sourceSessionId: 'thread-1',
                status: 'unavailable',
                reason: 'error',
            },
        });
    });

    it('extracts an explicit thread id for stale-event rejection', () => {
        expect(getCodexGoalEventThreadId({
            type: 'thread_goal_updated',
            goal: { threadId: 'thread-from-goal' },
        })).toBe('thread-from-goal');
        expect(getCodexGoalEventThreadId({ type: 'thread_goal_cleared' })).toBeNull();
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
        expect(parseCodexGoalCommand('/goal pause')).toEqual({
            type: 'set-status',
            status: 'paused',
        });
        expect(parseCodexGoalCommand('/goal RESUME')).toEqual({
            type: 'set-status',
            status: 'active',
        });
        expect(parseCodexGoalCommand('/goal edit')).toEqual({
            type: 'edit',
        });
    });

    it('only reserves exact action words', () => {
        expect(parseCodexGoalCommand('/goal resume migration work')).toEqual({
            type: 'set',
            objective: 'resume migration work',
        });
        expect(parseCodexGoalCommand('/goal pause notifications rollout')).toEqual({
            type: 'set',
            objective: 'pause notifications rollout',
        });
        expect(parseCodexGoalCommand('/goal clear old failures')).toEqual({
            type: 'set',
            objective: 'clear old failures',
        });
        expect(parseCodexGoalCommand('/goal edit the release objective')).toEqual({
            type: 'set',
            objective: 'edit the release objective',
        });
    });

    it('ignores empty goal commands and ordinary text', () => {
        expect(parseCodexGoalCommand('/goal')).toBeNull();
        expect(parseCodexGoalCommand('please /goal finish the release')).toBeNull();
    });
});

describe('parseCodexGoalActionParams', () => {
    it('parses clear, edit, pause, and resume RPC params into Codex goal commands', () => {
        expect(parseCodexGoalActionParams({ action: 'clear' })).toEqual({
            type: 'clear',
        });
        expect(parseCodexGoalActionParams({ action: 'edit', objective: '  revised goal  ' })).toEqual({
            type: 'set',
            objective: 'revised goal',
        });
        expect(parseCodexGoalActionParams({ action: 'pause' })).toEqual({
            type: 'set-status',
            status: 'paused',
        });
        expect(parseCodexGoalActionParams({ action: 'resume' })).toEqual({
            type: 'set-status',
            status: 'active',
        });
    });

    it('rejects unsupported or empty goal action params', () => {
        expect(parseCodexGoalActionParams({ action: 'stop' })).toBeNull();
        expect(parseCodexGoalActionParams({ action: 'edit', objective: '   ' })).toBeNull();
        expect(parseCodexGoalActionParams({ action: 'edit' })).toBeNull();
    });
});

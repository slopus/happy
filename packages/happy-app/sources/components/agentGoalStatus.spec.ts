import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { resolveVisibleAgentGoalStatus } from './agentGoalStatus';

function sessionWith(overrides: Partial<Session>): Session {
    return {
        id: 'happy-session-1',
        seq: 1,
        createdAt: 1000,
        updatedAt: 2000,
        active: true,
        activeAt: 10_000,
        metadata: {
            path: '/tmp/project',
            host: 'local',
            claudeSessionId: 'claude-session-1',
            codexThreadId: 'codex-thread-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('resolveVisibleAgentGoalStatus', () => {
    it('returns an active goal for the current Claude session identity', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'finish the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                    capabilities: { clear: true },
                },
            },
        }));

        expect(visible?.text).toBe('finish the branch');
        expect(visible?.providerStatus).toBe('active');
        expect(visible?.capabilities?.clear).toBe(true);
    });

    it('returns an active goal for the current Codex thread identity', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'review the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'codex-thread-1',
                },
            },
        }));

        expect(visible?.text).toBe('review the branch');
    });

    it('prefers a V2 paused goal and exposes only V2 lifecycle capabilities', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'legacy projection',
                    observedAt: 11_000,
                    sourceSessionId: 'codex-thread-1',
                    capabilities: { clear: true, stop: true },
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'review the branch',
                    observedAt: 11_001,
                    sourceSessionId: 'codex-thread-1',
                    capabilities: { clear: true, edit: true, resume: true },
                },
            },
        }));

        expect(visible).toMatchObject({
            text: 'review the branch',
            providerStatus: 'paused',
            capabilities: { resume: true },
        });
        expect(visible?.capabilities).not.toHaveProperty('stop');
    });

    it('ignores V2 from an old thread and uses V1 for the current thread', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            metadata: {
                path: '/tmp/project',
                host: 'local',
                codexThreadId: 'codex-thread-2',
            },
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'current thread goal',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-2',
                    sourceRevision: 2,
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'old thread goal',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 3,
                    capabilities: { resume: true },
                },
            },
        }));

        expect(visible).toMatchObject({
            text: 'current thread goal',
            sourceSessionId: 'codex-thread-2',
            providerStatus: 'active',
        });
    });

    it('uses a newer V1 revision instead of an older V2 projection', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'new V1 goal',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 5,
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'old V2 goal',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 4,
                    capabilities: { resume: true },
                },
            },
        }));

        expect(visible).toMatchObject({
            text: 'new V1 goal',
            providerStatus: 'active',
            sourceRevision: 5,
        });
    });

    it('uses observedAt when source revisions cannot be ordered', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'newly observed V1 goal',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 'revision-new',
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'older observed V2 goal',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 'revision-old',
                    capabilities: { resume: true },
                },
            },
        }));

        expect(visible?.text).toBe('newly observed V1 goal');
        expect(visible?.providerStatus).toBe('active');
    });

    it('uses newer V1 observedAt when source revisions are equal', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'later V1 observation',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 6,
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'earlier V2 observation',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 6,
                    capabilities: { resume: true },
                },
            },
        }));

        expect(visible?.text).toBe('later V1 observation');
        expect(visible?.providerStatus).toBe('active');
    });

    it('uses newer V1 when an older V2 projection is inactive', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'resumed goal',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 8,
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'inactive',
                    source: 'codex',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 7,
                    reason: 'cleared',
                },
            },
        }));

        expect(visible).toMatchObject({
            text: 'resumed goal',
            providerStatus: 'active',
            sourceRevision: 8,
        });
    });

    it('prefers V2 when both projections have the same freshness', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'legacy projection',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 9,
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'active',
                    providerStatus: 'paused',
                    source: 'codex',
                    text: 'detailed projection',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                    sourceRevision: 9,
                    capabilities: { resume: true },
                },
            },
        }));

        expect(visible).toMatchObject({
            text: 'detailed projection',
            providerStatus: 'paused',
            sourceRevision: 9,
        });
    });

    it('falls back to current V1 when V2 explicitly reports stale data', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'current V1 goal',
                    observedAt: 12_000,
                    sourceSessionId: 'codex-thread-1',
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'unavailable',
                    source: 'codex',
                    observedAt: 13_000,
                    sourceSessionId: 'codex-thread-1',
                    reason: 'stale',
                },
            },
        }));

        expect(visible?.text).toBe('current V1 goal');
        expect(visible?.providerStatus).toBe('active');
    });

    it.each(['blocked', 'usageLimited', 'budgetLimited'] as const)(
        'keeps a V2 %s goal visible',
        (providerStatus) => {
            const visible = resolveVisibleAgentGoalStatus(sessionWith({
                agentState: {
                    agentGoalStatusV2: {
                        version: 2,
                        status: 'active',
                        providerStatus,
                        source: 'codex',
                        text: 'review the branch',
                        observedAt: 11_000,
                        sourceSessionId: 'codex-thread-1',
                    },
                },
            }));

            expect(visible?.providerStatus).toBe(providerStatus);
            expect(visible?.text).toBe('review the branch');
        },
    );

    it('does not fall back to a stale V1 goal when V2 is inactive', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'stale goal',
                    observedAt: 11_000,
                    sourceSessionId: 'codex-thread-1',
                },
                agentGoalStatusV2: {
                    version: 2,
                    status: 'inactive',
                    source: 'codex',
                    observedAt: 11_001,
                    sourceSessionId: 'codex-thread-1',
                    reason: 'cleared',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('falls back to V1 without turning its legacy stop capability into pause', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'legacy goal',
                    observedAt: 11_000,
                    sourceSessionId: 'codex-thread-1',
                    capabilities: { clear: true, edit: true, stop: true },
                },
            },
        }));

        expect(visible?.providerStatus).toBe('active');
        expect(visible?.capabilities).toEqual({ clear: true, edit: true });
    });

    it('hides inactive, unavailable, and missing goal states', () => {
        expect(resolveVisibleAgentGoalStatus(sessionWith({ agentState: null }))).toBeNull();

        expect(resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'inactive',
                    source: 'claude',
                    observedAt: 11_000,
                    reason: 'completed',
                },
            },
        }))).toBeNull();

        expect(resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'unavailable',
                    source: 'codex',
                    observedAt: 11_000,
                    reason: 'unsupported',
                },
            },
        }))).toBeNull();
    });

    it('hides active goals while the session is disconnected', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            presence: Date.now() - 60_000,
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'finish the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('keeps a matching active goal visible when heartbeat activeAt advances', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            activeAt: 20_000,
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'current goal',
                    observedAt: 19_999,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible?.text).toBe('current goal');
    });

    it('hides active goals whose source session id does not match metadata', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'old thread goal',
                    observedAt: 11_000,
                    sourceSessionId: 'different-thread',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals with sourceSessionId when metadata has no current agent id', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            metadata: {
                path: '/tmp/project',
                host: 'local',
            },
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'unverifiable goal',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals with blank sourceSessionId defensively', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'blank identity goal',
                    observedAt: 11_000,
                    sourceSessionId: '',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals without sourceSessionId defensively', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'unverifiable current-run goal',
                    observedAt: 10_001,
                } as any,
            },
        }));

        expect(visible).toBeNull();
    });

    it('does not invent visible goal state without agentGoalStatus', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {},
        }));

        expect(visible).toBeNull();
    });
});

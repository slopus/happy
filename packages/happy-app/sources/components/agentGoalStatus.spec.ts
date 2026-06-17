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
});

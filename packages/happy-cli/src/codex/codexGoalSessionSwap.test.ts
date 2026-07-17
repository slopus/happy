import { describe, expect, it, vi } from 'vitest';

import type { AgentState, Metadata } from '@/api/types';
import type { CodexGoalProjection } from './codexGoalStatus';
import { syncCodexSessionAfterSwap } from './codexGoalSessionSwap';

function projection(revision: number): CodexGoalProjection {
    return {
        legacy: {
            source: 'codex',
            observedAt: revision,
            sourceSessionId: 'thread-1',
            sourceRevision: revision,
            status: 'active',
            text: 'finish the release',
        },
        detailed: {
            version: 2,
            source: 'codex',
            observedAt: revision,
            sourceSessionId: 'thread-1',
            sourceRevision: revision,
            status: 'active',
            text: 'finish the release',
            providerStatus: 'active',
        },
    };
}

describe('syncCodexSessionAfterSwap', () => {
    it('registers goal RPC, restores thread metadata, and refuses a stale projection', () => {
        let updateState!: (currentState: AgentState) => AgentState;
        let updateMetadata!: (currentMetadata: Metadata) => Metadata;
        const registerHandler = vi.fn();
        const handler = vi.fn(async () => ({ ok: true as const }));

        syncCodexSessionAfterSwap({
            session: {
                updateAgentState: (update) => { updateState = update; },
                updateMetadata: (update) => { updateMetadata = update; },
                rpcHandlerManager: { registerHandler },
            },
            projection: projection(10),
            goalActionRpcHandler: handler,
            threadId: 'thread-1',
        });

        const newerState: AgentState = {
            agentGoalStatus: projection(11).legacy,
            agentGoalStatusV2: projection(11).detailed,
        };
        expect(updateState(newerState)).toBe(newerState);
        expect(updateMetadata({ codexThreadId: 'old-thread' } as Metadata)).toMatchObject({
            codexThreadId: 'thread-1',
        });
        expect(registerHandler).toHaveBeenCalledWith('goal-action', handler);
    });

    it('clears stale thread metadata when the swapped session has no active Codex thread', () => {
        let updateMetadata!: (currentMetadata: Metadata) => Metadata;

        syncCodexSessionAfterSwap({
            session: {
                updateAgentState: vi.fn(),
                updateMetadata: (update) => { updateMetadata = update; },
                rpcHandlerManager: { registerHandler: vi.fn() },
            },
            threadId: null,
        });

        expect(updateMetadata({ codexThreadId: 'stale-thread', name: 'session' } as Metadata)).toEqual({
            name: 'session',
        });
    });
});

import { describe, expect, it } from 'vitest';
import { getAgentStateDecryptFallback } from './agentStateFallback';
import type { AgentState, Session } from './storageTypes';

describe('getAgentStateDecryptFallback', () => {
    it('keeps the previous local agentState for the same session', () => {
        const previousAgentState: AgentState = {
            requests: {
                permission1: {
                    tool: 'Bash',
                    arguments: { command: 'npm test' },
                    createdAt: 123,
                },
            },
        };
        const sessions = {
            session1: {
                agentState: previousAgentState,
            } as Session,
        };

        expect(getAgentStateDecryptFallback(sessions, 'session1')).toBe(previousAgentState);
    });

    it('falls back to empty state when there is no previous local session state', () => {
        expect(getAgentStateDecryptFallback({}, 'missing')).toEqual({});
    });
});

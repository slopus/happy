import { describe, expect, it } from 'vitest';

import { resolveSessionState } from './sessionState';
import type { AgentState } from './storageTypes';

function agentState({
    permission = false,
    communication = false,
    completed = false,
}: {
    permission?: boolean;
    communication?: boolean;
    completed?: boolean;
} = {}): AgentState {
    return {
        requests: permission
            ? { permission: { tool: 'Bash', arguments: {} } }
            : {},
        communications: communication
            ? {
                question: {
                    kind: 'form',
                    form: {
                        questions: [{
                            id: 'choice',
                            header: 'Choice',
                            question: 'Pick one',
                            options: [{ label: 'One' }],
                        }],
                    },
                },
            }
            : {},
        completedCommunications: completed
            ? { question: { kind: 'form', status: 'answered', form: { questions: [] } } }
            : {},
    } as AgentState;
}

describe('resolveSessionState', () => {
    it('reports a pending agent question as input required ahead of thinking', () => {
        expect(resolveSessionState({
            agentState: agentState({ communication: true }),
            thinking: true,
            isOnline: true,
        })).toBe('input_required');
    });

    it('keeps permission and connection precedence', () => {
        expect(resolveSessionState({
            agentState: agentState({ permission: true, communication: true }),
            thinking: true,
            isOnline: true,
        })).toBe('permission_required');
        expect(resolveSessionState({
            agentState: agentState({ permission: true, communication: true }),
            thinking: true,
            isOnline: false,
        })).toBe('disconnected');
    });

    it('ignores completed questions and falls back to thinking or waiting', () => {
        const completedQuestion = agentState({ communication: true, completed: true });
        expect(resolveSessionState({
            agentState: completedQuestion,
            thinking: true,
            isOnline: true,
        })).toBe('thinking');
        expect(resolveSessionState({
            agentState: completedQuestion,
            thinking: false,
            isOnline: true,
        })).toBe('waiting');
    });
});
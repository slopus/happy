import { describe, expect, it } from 'vitest';
import { buildAgentTurnCopyTextByMessageId, type AgentTurnCopyMessage } from './agentTurnCopy';

describe('buildAgentTurnCopyTextByMessageId', () => {
    it('copies every non-thinking text block without tool calls', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'agent-text', id: 'final', text: 'Final answer' },
            { kind: 'tool-call', id: 'tool' },
            { kind: 'agent-text', id: 'progress', text: 'Progress update' },
            { kind: 'agent-text', id: 'thinking', text: 'Private thought', isThinking: true },
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: true })).toEqual(
            new Map([['final', 'Progress update\n\nFinal answer']]),
        );
    });

    it('does not offer copy while the current turn is still running', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'agent-text', id: 'streaming', text: 'Still working' },
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: false }).size).toBe(0);
    });

    it('does not add a copy button to streaming work when a pending prompt appears below it', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'user-text', id: 'pending', text: 'One more thing', pending: true },
            { kind: 'agent-text', id: 'streaming', text: 'Still working', turn: 'current' },
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: false }).size).toBe(0);
    });

    it('reuses the joined text of a turn whose messages are unchanged', () => {
        let textReads = 0;
        const block = (id: string, text: string): AgentTurnCopyMessage => ({
            kind: 'agent-text',
            id,
            get text() {
                textReads++;
                return text;
            },
        });
        const messages: AgentTurnCopyMessage[] = [
            block('final', 'Final answer'),
            block('progress', 'Progress update'),
            { kind: 'user-text', id: 'user', text: 'Do it' },
        ];

        const first = buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: true });
        const readsForFirst = textReads;
        textReads = 0;
        const second = buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: true });

        expect(second).toEqual(first);
        // The classification pass still reads each block; the join must not.
        expect(textReads).toBeLessThan(readsForFirst);
    });

    it('still offers copy for completed historical turns', () => {
        const messages: AgentTurnCopyMessage[] = [
            { kind: 'user-text', id: 'current-user', text: 'Next task' },
            { kind: 'agent-text', id: 'previous-final', text: 'Previous answer' },
            { kind: 'user-text', id: 'previous-user', text: 'Previous task' },
        ];

        expect(buildAgentTurnCopyTextByMessageId(messages, { currentTurnComplete: false })).toEqual(
            new Map([['previous-final', 'Previous answer']]),
        );
    });
});
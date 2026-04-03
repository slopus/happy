import { describe, expect, it } from 'vitest';

import {
    applyAgentMessageToAcpxTurn,
    applyClaudeAssistantMessageToAcpxTurn,
    applyClaudeToolResultsToAcpxTurn,
    applyPseudoEventToAcpxTurn,
    createAcpxTurn,
    createClaudeUserMessage,
    getUserMessageText,
    hasAcpxTurnContent,
    resetAcpxTurn,
} from './acpxTurn';

describe('acpxTurn', () => {
    it('accumulates raw agent events into an acpx agent turn', () => {
        const turn = createAcpxTurn();

        applyAgentMessageToAcpxTurn(turn, { type: 'model-output', textDelta: 'Hello' });
        applyAgentMessageToAcpxTurn(turn, { type: 'model-output', fullText: ' world' });
        applyAgentMessageToAcpxTurn(turn, { type: 'event', name: 'thinking', payload: { text: 'Reason' } });
        applyAgentMessageToAcpxTurn(turn, {
            type: 'tool-call',
            callId: 'tool-1',
            toolName: 'Read',
            args: { file: 'README.md' },
        });
        applyAgentMessageToAcpxTurn(turn, {
            type: 'tool-result',
            callId: 'tool-1',
            toolName: 'Read',
            result: { Text: 'contents' },
        });

        expect(turn.message).toEqual({
            Agent: {
                content: [
                    { Text: 'Hello world' },
                    { Thinking: { text: 'Reason' } },
                    {
                        ToolUse: {
                            id: 'tool-1',
                            name: 'Read',
                            input: { file: 'README.md' },
                            raw_input: '{\n  "file": "README.md"\n}',
                            is_input_complete: true,
                        },
                    },
                ],
                tool_results: {
                    'tool-1': {
                        tool_use_id: 'tool-1',
                        tool_name: 'Read',
                        is_error: false,
                        content: { Text: 'contents' },
                        output: { Text: 'contents' },
                    },
                },
            },
        });
        expect(hasAcpxTurnContent(turn)).toBe(true);

        resetAcpxTurn(turn);

        expect(turn.message).toEqual({
            Agent: {
                content: [],
                tool_results: {},
            },
        });
        expect(hasAcpxTurnContent(turn)).toBe(false);
    });

    it('maps pseudo events including tool results without a prior tool use name', () => {
        const turn = createAcpxTurn();

        applyPseudoEventToAcpxTurn(turn, { type: 'reasoning', message: 'Plan' });
        applyPseudoEventToAcpxTurn(turn, { type: 'tool-call', callId: 'tool-2', name: 'Write', input: { path: 'a.ts' } });
        applyPseudoEventToAcpxTurn(turn, { type: 'tool-result', callId: 'tool-2', output: { ok: true } });
        applyPseudoEventToAcpxTurn(turn, { type: 'tool-result', callId: 'tool-3', output: 'missing use' });

        expect(turn.message.Agent.content).toEqual([
            { Thinking: { text: 'Plan' } },
            {
                ToolUse: {
                    id: 'tool-2',
                    name: 'Write',
                    input: { path: 'a.ts' },
                    raw_input: '{\n  "path": "a.ts"\n}',
                    is_input_complete: true,
                },
            },
        ]);
        expect(turn.message.Agent.tool_results).toEqual({
            'tool-2': {
                tool_use_id: 'tool-2',
                tool_name: 'Write',
                is_error: false,
                content: { Text: '{\n  "ok": true\n}' },
                output: { ok: true },
            },
            'tool-3': {
                tool_use_id: 'tool-3',
                tool_name: 'tool',
                is_error: false,
                content: { Text: 'missing use' },
                output: 'missing use',
            },
        });
    });

    it('maps Claude assistant blocks into acpx content', () => {
        const turn = createAcpxTurn();

        applyClaudeAssistantMessageToAcpxTurn(turn, {
            type: 'assistant',
            uuid: 'assistant-1',
            message: {
                content: [
                    { type: 'text', text: 'Alpha' },
                    { type: 'thinking', thinking: 'Beta', signature: 'sig-1' },
                    { type: 'redacted_thinking', data: 'secret' },
                    {
                        type: 'tool_use',
                        id: 'tool-4',
                        name: 'Bash',
                        input: { cmd: 'pwd' },
                        thought_signature: 'tool-sig',
                    },
                ],
            },
        });

        expect(turn.message.Agent.content).toEqual([
            { Text: 'Alpha' },
            { Thinking: { text: 'Beta', signature: 'sig-1' } },
            { RedactedThinking: 'secret' },
            {
                ToolUse: {
                    id: 'tool-4',
                    name: 'Bash',
                    input: { cmd: 'pwd' },
                    raw_input: '{\n  "cmd": "pwd"\n}',
                    is_input_complete: true,
                    thought_signature: 'tool-sig',
                },
            },
        ]);
    });

    it('maps Claude user messages and tool results', () => {
        const turn = createAcpxTurn();
        applyClaudeAssistantMessageToAcpxTurn(turn, {
            type: 'assistant',
            uuid: 'assistant-2',
            message: {
                content: [
                    { type: 'tool_use', id: 'tool-5', name: 'Read', input: { file: 'package.json' } },
                ],
            },
        });

        const userMessage = createClaudeUserMessage({
            type: 'user',
            uuid: 'user-1',
            message: {
                content: [
                    { type: 'text', text: 'follow up' },
                    { type: 'image', source: 'ignored' },
                ],
            },
        });

        expect(userMessage).toEqual({
            User: {
                id: 'user-1',
                content: [{ Text: 'follow up' }],
            },
        });
        expect(getUserMessageText(userMessage!)).toBe('follow up');

        expect(
            applyClaudeToolResultsToAcpxTurn(turn, {
                type: 'user',
                uuid: 'user-2',
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool-5',
                            content: 'done',
                            is_error: false,
                        },
                    ],
                },
            }),
        ).toBe(true);

        expect(turn.message.Agent.tool_results['tool-5']).toEqual({
            tool_use_id: 'tool-5',
            tool_name: 'Read',
            is_error: false,
            content: { Text: 'done' },
            output: 'done',
        });
    });
});

import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getAskUserQuestionToolCallIds } from './questionNotification';

function msg(partial: Record<string, unknown>): SDKMessage {
    return partial as unknown as SDKMessage;
}

describe('getAskUserQuestionToolCallIds', () => {
    it('returns AskUserQuestion tool ids from assistant messages', () => {
        expect(getAskUserQuestionToolCallIds(msg({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Need clarification.' },
                    { type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: { question: 'Choose one' } },
                    { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } },
                ]
            }
        }))).toEqual(['tool-1']);
    });

    it('returns an empty array for non-assistant messages', () => {
        expect(getAskUserQuestionToolCallIds(msg({
            type: 'user',
            message: { role: 'user', content: 'hello' }
        }))).toEqual([]);
    });

    it('returns an empty array when there is no AskUserQuestion tool call', () => {
        expect(getAskUserQuestionToolCallIds(msg({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } },
                ]
            }
        }))).toEqual([]);
    });
});

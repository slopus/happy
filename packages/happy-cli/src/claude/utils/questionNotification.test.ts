import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '../sdk';
import { getAskUserQuestionToolCallIds } from './questionNotification';

describe('getAskUserQuestionToolCallIds', () => {
    it('returns AskUserQuestion tool ids from assistant messages', () => {
        const message: SDKMessage = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Need clarification.' },
                    { type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: { question: 'Choose one' } },
                    { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } },
                ]
            }
        };

        expect(getAskUserQuestionToolCallIds(message)).toEqual(['tool-1']);
    });

    it('returns an empty array for non-assistant messages', () => {
        const message: SDKMessage = {
            type: 'user',
            message: {
                role: 'user',
                content: 'hello',
            }
        };

        expect(getAskUserQuestionToolCallIds(message)).toEqual([]);
    });

    it('returns an empty array when there is no AskUserQuestion tool call', () => {
        const message: SDKMessage = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'README.md' } },
                ]
            }
        };

        expect(getAskUserQuestionToolCallIds(message)).toEqual([]);
    });
});

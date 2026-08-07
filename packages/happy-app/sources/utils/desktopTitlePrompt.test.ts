import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '@/hooks/useGroupedMessages';
import { getDesktopTitlePromptMessageId } from './desktopTitlePrompt';

function userMessage(id: string, text: string, displayText?: string): DisplayItem {
    return {
        type: 'message',
        id,
        message: {
            kind: 'user-text',
            id,
            localId: null,
            createdAt: Number(id.replace(/\D/g, '')),
            text,
            ...(displayText ? { displayText } : {}),
        },
    };
}

describe('getDesktopTitlePromptMessageId', () => {
    it('returns the oldest user prompt', () => {
        const items = [
            userMessage('message-2', 'Follow-up prompt'),
            userMessage('message-1', '  # Optimize batch image generation  '),
        ];

        expect(getDesktopTitlePromptMessageId(items, true)).toBe('message-1');
    });

    it('keeps hiding the title prompt after the session is renamed', () => {
        expect(getDesktopTitlePromptMessageId(
            [userMessage('message-1', 'Optimize batch image generation')],
            true,
        )).toBe('message-1');
    });

    it('only removes the oldest user prompt', () => {
        const items = [
            userMessage('message-2', 'Image workflow follow-up'),
            userMessage('message-1', 'Optimize batch image generation'),
        ];

        expect(getDesktopTitlePromptMessageId(items, true)).toBe('message-1');
    });

    it('keeps every loaded user message while older pages are still available', () => {
        const items = [
            userMessage('message-102', 'Newest follow-up'),
            userMessage('message-3', 'Oldest user message in the loaded page'),
        ];

        expect(getDesktopTitlePromptMessageId(items, false)).toBeNull();
    });
});

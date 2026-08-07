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
    it('returns the oldest user prompt when it produced the session title', () => {
        const items = [
            userMessage('message-2', 'Follow-up prompt'),
            userMessage('message-1', '  # Optimize batch image generation  '),
        ];

        expect(getDesktopTitlePromptMessageId(items, 'Optimize batch image generation')).toBe('message-1');
    });

    it('keeps the first prompt when the session has a different title', () => {
        expect(getDesktopTitlePromptMessageId(
            [userMessage('message-1', 'Optimize batch image generation')],
            'Image workflow follow-up',
        )).toBeNull();
    });

    it('matches the visible prompt text when the raw payload is decorated', () => {
        expect(getDesktopTitlePromptMessageId(
            [userMessage(
                'message-1',
                'Optimize batch image generation\n\n[hidden attachment and runtime instructions]',
                'Optimize batch image generation',
            )],
            'Optimize batch image generation',
        )).toBe('message-1');
    });

    it('only considers the oldest visible user prompt', () => {
        const items = [
            userMessage('message-2', 'Image workflow follow-up'),
            userMessage('message-1', 'Optimize batch image generation'),
        ];

        expect(getDesktopTitlePromptMessageId(items, 'Image workflow follow-up')).toBeNull();
    });
});

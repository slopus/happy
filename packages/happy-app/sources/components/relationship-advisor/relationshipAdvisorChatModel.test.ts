import { describe, expect, it } from 'vitest';

import {
    relationshipAdvisorChatReducer,
    shouldShowRelationshipAdvisorEmptyState,
    type RelationshipAdvisorChatState,
} from './relationshipAdvisorChatModel';

describe('relationshipAdvisorChatReducer', () => {
    it('builds one streaming assistant message and commits it on done', () => {
        const initial: RelationshipAdvisorChatState = {
            messages: [],
            activeRequestId: null,
            streamingText: '',
            error: null,
        };
        const userMessage = {
            id: 'user-1',
            role: 'user' as const,
            text: '她只回了哈哈',
            createdAt: 1,
            imageCount: 0,
        };

        const started = relationshipAdvisorChatReducer(initial, {
            type: 'start',
            requestId: 'request-1',
            message: userMessage,
        });
        const first = relationshipAdvisorChatReducer(started, {
            type: 'event',
            event: { requestId: 'request-1', type: 'delta', text: '先别' },
        });
        const second = relationshipAdvisorChatReducer(first, {
            type: 'event',
            event: { requestId: 'request-1', type: 'delta', text: '追问。' },
        });
        const done = relationshipAdvisorChatReducer(second, {
            type: 'event',
            event: { requestId: 'request-1', type: 'done' },
            completedAt: 2,
        });

        expect(done.activeRequestId).toBeNull();
        expect(done.streamingText).toBe('');
        expect(done.messages).toEqual([
            userMessage,
            {
                id: 'assistant-request-1',
                role: 'assistant',
                text: '先别追问。',
                createdAt: 2,
                imageCount: 0,
            },
        ]);
    });

    it('keeps partial assistant text visible when the provider fails', () => {
        const state: RelationshipAdvisorChatState = {
            messages: [{ id: 'user-request-2', role: 'user', text: '继续', createdAt: 1, imageCount: 0 }],
            activeRequestId: 'request-2',
            streamingText: '已经生成的部分',
            error: null,
        };

        const failed = relationshipAdvisorChatReducer(state, {
            type: 'event',
            event: { requestId: 'request-2', type: 'error', error: 'unavailable' },
            completedAt: 2,
        });

        expect(failed.messages.at(-1)).toEqual({
            id: 'assistant-request-2',
            role: 'assistant',
            text: '已经生成的部分',
            createdAt: 2,
            imageCount: 0,
        });
        expect(failed.streamingText).toBe('');
        expect(failed.error).toBe('unavailable');
    });

    it('keeps the first-turn failure and retry state visible instead of showing the empty prompt', () => {
        const started: RelationshipAdvisorChatState = {
            messages: [{ id: 'user-request-3', role: 'user', text: '帮我看看', createdAt: 1, imageCount: 1 }],
            activeRequestId: 'request-3',
            streamingText: '',
            error: null,
        };

        const failed = relationshipAdvisorChatReducer(started, {
            type: 'fail-before-start',
            requestId: 'request-3',
            error: 'unavailable',
        });

        expect(failed.messages).toEqual([]);
        expect(failed.error).toBe('unavailable');
        expect(shouldShowRelationshipAdvisorEmptyState(failed)).toBe(false);
    });
});

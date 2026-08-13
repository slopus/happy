import { describe, expect, it } from 'vitest';

import {
    buildRelationshipAdvisorConversationTitle,
    MAX_RELATIONSHIP_ADVISOR_HISTORY_CHARACTERS,
    removeRelationshipAdvisorConversation,
    saveRelationshipAdvisorConversation,
    type RelationshipAdvisorConversation,
} from './relationshipAdvisorHistoryModel';

describe('relationship advisor conversation history', () => {
    it('uses the first user message as a compact single-line title', () => {
        expect(buildRelationshipAdvisorConversationTitle([
            { id: 'assistant-1', role: 'assistant', text: '先说说情况', createdAt: 1, imageCount: 0 },
            { id: 'user-1', role: 'user', text: '  她突然问我\n周末有没有空，要怎么回？  ', createdAt: 2, imageCount: 0 },
        ])).toBe('她突然问我 周末有没有空，要怎么回？');
    });

    it('updates one conversation, sorts by activity, and keeps the newest 30', () => {
        const conversations: RelationshipAdvisorConversation[] = Array.from({ length: 30 }, (_, index) => ({
            id: `conversation-${index}`,
            title: `Conversation ${index}`,
            createdAt: index,
            updatedAt: index,
            messages: [],
        }));
        const saved = saveRelationshipAdvisorConversation(conversations, {
            id: 'new-conversation',
            title: 'New conversation',
            createdAt: 100,
            updatedAt: 100,
            messages: [],
        });

        expect(saved).toHaveLength(30);
        expect(saved[0]?.id).toBe('new-conversation');
        expect(saved.some((conversation) => conversation.id === 'conversation-0')).toBe(false);
    });

    it('removes only the selected conversation', () => {
        const conversations: RelationshipAdvisorConversation[] = [
            { id: 'one', title: 'One', createdAt: 1, updatedAt: 1, messages: [] },
            { id: 'two', title: 'Two', createdAt: 2, updatedAt: 2, messages: [] },
        ];

        expect(removeRelationshipAdvisorConversation(conversations, 'one').map(({ id }) => id)).toEqual(['two']);
    });

    it('keeps total stored message text within the device-local history budget', () => {
        const oversized = 'x'.repeat(MAX_RELATIONSHIP_ADVISOR_HISTORY_CHARACTERS);
        const saved = saveRelationshipAdvisorConversation([], {
            id: 'large',
            title: 'Large',
            createdAt: 1,
            updatedAt: 2,
            messages: [
                { id: 'old', role: 'user', text: oversized, createdAt: 1, imageCount: 0 },
                { id: 'new', role: 'assistant', text: 'latest', createdAt: 2, imageCount: 0 },
            ],
        });

        expect(saved[0]?.messages.map(({ id }) => id)).toEqual(['new']);
    });
});

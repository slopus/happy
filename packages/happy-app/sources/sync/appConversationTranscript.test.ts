import { describe, expect, it } from 'vitest';
import { appConversationToMessages } from './appConversationTranscript';
import type { AppHistoryContent } from './appConversationHistory';

const content: AppHistoryContent = {
    appId: 'relationship-advisor', conversationId: 'conversation-a', grantId: 'grant-a', machineId: 'machine-a',
    createdAt: '2026-10-03T13:00:00.000Z', state: 'running',
    messages: [{ role: 'user', text: 'Look at this', images: ['data:image/png;base64,aGVsbG8='] }, { role: 'assistant', text: '**Hello**' }],
};

describe('application conversation transcript adapter', () => {
    it('uses the normal text and attachment message shapes in newest-first order', () => {
        const messages = appConversationToMessages(content);
        expect(messages.map(message => message.kind)).toEqual(['agent-text', 'user-text', 'tool-call']);
        expect(messages[0]).toMatchObject({ text: '**Hello**', localId: null });
        expect(messages[2]).toMatchObject({ tool: { name: 'file', state: 'completed', input: {
            ref: content.messages[0].images![0], kind: 'image', encrypted: false, source: 'user', mimeType: 'image/png',
        } } });
        expect(new Set(messages.map(message => message.id)).size).toBe(3);
    });

    it('keeps row identity stable while a response grows and scopes it to the conversation', () => {
        const initial = appConversationToMessages(content);
        const updated = appConversationToMessages({ ...content, messages: [content.messages[0], { role: 'assistant', text: '**Hello** again' }] });
        expect(updated.map(message => message.id)).toEqual(initial.map(message => message.id));
        const other = appConversationToMessages({ ...content, conversationId: 'conversation-b' });
        expect(other.every(message => !initial.some(previous => previous.id === message.id))).toBe(true);
    });
});

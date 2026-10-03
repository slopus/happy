import type { AppHistoryContent } from './appConversationHistory';
import type { Message } from './typesMessage';

/** Adapt app text/images to Paws' normal newest-first transcript model. */
export function appConversationToMessages(content: AppHistoryContent): Message[] {
    const messages: Message[] = [];
    // The protocol has a conversation timestamp, but no per-message timestamps.
    const createdAt = Date.parse(content.createdAt);
    content.messages.forEach((message, index) => {
        const id = `app:${content.conversationId}:${index}`;
        message.images?.forEach((ref, imageIndex) => {
            const mimeType = ref.slice(5, ref.indexOf(';'));
            messages.push({
                kind: 'tool-call', id: `${id}:image:${imageIndex}`, localId: null, createdAt,
                tool: {
                    name: 'file', state: 'completed', createdAt, startedAt: createdAt, completedAt: createdAt,
                    description: null,
                    input: { ref, name: `image-${imageIndex + 1}.${mimeType.split('/')[1]}`, kind: 'image', mimeType, encrypted: false, source: message.role },
                },
                children: [],
            });
        });
        messages.push({ kind: message.role === 'user' ? 'user-text' : 'agent-text', id, localId: null, createdAt, text: message.text });
    });
    return messages.reverse();
}

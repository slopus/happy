import { z } from 'zod';
import type { Message } from './typesMessage';

export const messageOptionResponseSchema = z.object({
    status: z.enum(['answered', 'dismissed']),
    answer: z.string().optional(),
    updatedAt: z.number().finite(),
});
export type MessageOptionResponse = z.infer<typeof messageOptionResponseSchema>;

/** Prefer wire/block identity; legacy unindexed text still needs a replay-stable key. */
export function messageOptionKey(message: { text: string; createdAt: number }, wire?: string | null, block?: string | null) {
    if (wire) return JSON.stringify([wire, block ?? 'text:0']);
    let hash = 2166136261;
    for (let i = 0; i < message.text.length; i++) hash = Math.imul(hash ^ message.text.charCodeAt(i), 16777619);
    return JSON.stringify(['legacy', message.createdAt, hash >>> 0]);
}

/** Legacy cards have no receipt. A subsequent user reply closes the earlier
 * question, including replies sent through the normal composer or another device. */
export function inferMessageOptionResponses(messages: readonly Message[]) {
    const responses = new Map<string, MessageOptionResponse>();
    let reply: Extract<Message, { kind: 'user-text' }> | undefined;
    for (const message of [...messages].sort((a, b) => b.createdAt - a.createdAt)) {
        if (message.kind === 'user-text') reply = message;
        else if (reply && message.kind === 'agent-text' && message.text.includes('<options>')) {
            responses.set(message.id, { status: 'answered', answer: reply.displayText ?? reply.text, updatedAt: reply.createdAt });
        }
    }
    return responses;
}

export function withMessageOptionResponse<T extends { messageOptionResponses?: Record<string, MessageOptionResponse> }>(metadata: T, key: string, response: MessageOptionResponse): T {
    if (metadata.messageOptionResponses?.[key]) return metadata;
    return { ...metadata, messageOptionResponses: { ...metadata.messageOptionResponses, [key]: response } };
}

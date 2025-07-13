import { z } from 'zod';

//
// Content types
//

// Human content schema
export const HumanContentSchema = z.object({
    type: z.literal('human'),
    content: z.object({
        type: z.literal('text'),
        text: z.string(),
    }),
});

// Assistant content schema
export const AssistantContentSchema = z.object({
    type: z.literal('assistant'),
    content: z.object({
        type: z.literal('text'),
        text: z.string(),
    }),
});

// Message content schema (union)
export const MessageContentSchema = z.discriminatedUnion('type', [
    HumanContentSchema,
    AssistantContentSchema,
]);

// Type exports
export type HumanContent = z.infer<typeof HumanContentSchema>;
export type AssistantContent = z.infer<typeof AssistantContentSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;

//
// Session
//

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    lastMessage: MessageContent | null,
}

//
// Encrypted message
//

export const EncryptedMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    content: z.object({
        t: z.literal('encrypted'),
        c: z.string(), // Base64 encoded encrypted content
    }),
    createdAt: z.number(),
});

export type EncryptedMessage = z.infer<typeof EncryptedMessageSchema>;

//
// Decrypted message
//

export const DecryptedMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    content: MessageContentSchema.nullable(), // null if decryption failed
    createdAt: z.number(),
});

export type DecryptedMessage = z.infer<typeof DecryptedMessageSchema>;

//
// Updates
//

export const UpdateNewMessageSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(), // Session ID
    mid: z.string(), // Message ID
    c: z.object({
        t: z.literal('encrypted'),
        c: z.string(), // Base64 encoded encrypted content
    }),
});

export const UpdateSchema = z.discriminatedUnion('t', [
    UpdateNewMessageSchema,
]);

export type UpdateNewMessage = z.infer<typeof UpdateNewMessageSchema>;
export type Update = z.infer<typeof UpdateSchema>;

//
// Session update (full update structure)
//

export const SessionUpdateSchema = z.object({
    id: z.string(),
    seq: z.number(),
    content: UpdateSchema,
    createdAt: z.number(),
});

export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;
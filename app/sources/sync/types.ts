import { z } from 'zod';

//
// Content types
//

// Human content schema
export const HumanContentSchema = z.object({
    role: z.literal('user'),
    localKey: z.string(),
    content: z.object({
        type: z.literal('text'),
        text: z.string(),
    }),
});

// Assistant content schema
export const AssistantContentSchema = z.object({
    role: z.literal('agent'),
    content: z.any()
});

// Message content schema (union)
export const MessageContentSchema = z.discriminatedUnion('role', [
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
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    agentState: AgentState | null,
    lastMessage: Message | null,
    thinking: boolean,
    thinkingAt: number,
}

//
// Encrypted message
//

export const SourceMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    content: z.object({
        t: z.literal('encrypted'),
        c: z.string(), // Base64 encoded encrypted content
    }),
    createdAt: z.number(),
});

export type SourceMessage = z.infer<typeof SourceMessageSchema>;

//
// Decrypted message
//

export const MessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    content: MessageContentSchema.nullable(), // null if decryption failed
    createdAt: z.number(),
});

export type Message = z.infer<typeof MessageSchema>;

//
// Updates
//

export const UpdateNewMessageSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(), // Session ID
    message: SourceMessageSchema
});

export const UpdateNewSessionSchema = z.object({
    t: z.literal('new-session'),
    id: z.string(), // Session ID
    createdAt: z.number(),
    updatedAt: z.number(),
});

export const UpdateSchema = z.discriminatedUnion('t', [
    UpdateNewMessageSchema,
    UpdateNewSessionSchema
]);

export type UpdateNewMessage = z.infer<typeof UpdateNewMessageSchema>;
export type Update = z.infer<typeof UpdateSchema>;

//
// Session update (full update structure)
//

export const SessionUpdateSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: UpdateSchema,
    createdAt: z.number(),
});

export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

//
// Ephemeral update
//

export const EphemeralUpdateSchema = z.object({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: z.number(),
    thinking: z.boolean(),
});

export type EphemeralUpdate = z.infer<typeof EphemeralUpdateSchema>;

//
// Metadata
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    
});

export type AgentState = z.infer<typeof AgentStateSchema>;
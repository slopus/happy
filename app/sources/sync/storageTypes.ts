import { z } from "zod";

//
// Message content
//

export const UserContentSchema = z.object({
    role: z.literal('user'),
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
    UserContentSchema,
    AssistantContentSchema,
]);

// Type exports
export type UserContent = z.infer<typeof UserContentSchema>;
export type AssistantContent = z.infer<typeof AssistantContentSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;

//
// Agent states
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
    })).nullish(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    agentState: AgentState | null,
    lastMessage: DecryptedMessage | null,
    thinking: boolean,
    thinkingAt: number,
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    content: MessageContent | null,
    createdAt: number,
}

//
// Messsage type
//


export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    arguments: any;
    children: ToolCall[];
}

export type Message = {
    id: string;
    role: 'agent';
    createdAt: number;
    content: {
        type: 'text';
        text: string;
    } | {
        type: 'tool';
        tools: ToolCall[];
    }
} | {
    id: string;
    role: 'user';
    createdAt: number;
    content: {
        type: 'text';
        text: string;
    }
};
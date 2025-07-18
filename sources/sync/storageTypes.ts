import { z } from "zod";

//
// Message content
//

export const UserContentSchema = z.object({
    role: z.literal('user'),
    localId: z.string().nullish(),
    content: z.object({
        type: z.literal('text'),
        text: z.string(),
    }),
});

// Assistant content schema
export const AssistantContentSchema = z.object({
    role: z.literal('agent'),
    id: z.string().nullish(),
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
// UI Message Representation - Live status report of operations
//
// This section defines the Message type, which represents the state of individual UI 
// components in the chat interface. Each "Message" is essentially a live status report
// showing what operations are currently happening or have completed. This is NOT about
// conversation turns - it's about tracking parallel work in real-time.
//
// The key insight: when Claude starts a tool call, we immediately add it to the UI as
// element #2 in the list with state: 'running'. If Claude starts another tool before
// the first finishes, that becomes element #3. When tool #3 finishes, we update
// element #3 in-place to state: 'completed'. When tool #2 finishes later, we update
// element #2 in-place. Order is preserved by start time, not completion time.
//
// This handles nested tool calls too - each ToolCall can have children representing
// sub-operations, but we only show the high-level operations to save mobile screen
// real estate. Users can drill down to see the full operation tree on a detail screen
// if needed.
//
// Example timeline:
// - User asks question → element #1 (user message)
// - Claude starts file_search → element #2 added (state: 'running')
// - Claude starts grep_search → element #3 added (state: 'running') 
// - grep_search completes → element #3 updated in-place (state: 'completed')
// - file_search completes → element #2 updated in-place (state: 'completed')
//
// Each Message aggregates multiple underlying Claude protocol messages but presents
// a clean, mobile-friendly view of "what's Claude working on right now?" and "what
// has Claude done?"
//


export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    arguments: any;
    result?: unknown; // Add result field to store toolUseResult data
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
    localId: string | null;
    content: {
        type: 'text';
        text: string;
    }
};
export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: any;
    result?: unknown;
    children: ToolCall[];
}

// Flattened message types - each message represents a single block
export type UserTextMessage = {
    id: string;
    localId: string | null;
    createdAt: number;
    kind: 'user-text';
    text: string;
}

export type AgentTextMessage = {
    id: string;
    localId: string | null;
    createdAt: number;
    kind: 'agent-text';
    text: string;
}

export type ToolCallMessage = {
    id: string;
    localId: string | null;
    createdAt: number;
    kind: 'tool-call';
    tools: ToolCall[];
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage;
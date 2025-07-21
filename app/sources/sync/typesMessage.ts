export type ToolCall = {
    name: string;
    input: any;
    state: 'running' | 'completed' | 'error';
    children: ToolCall[];
    result?: unknown;
}

export type UserMessage = {
    id: string;
    localId: string | null;
    createdAt: number;
    role: 'user';
    content: {
        type: 'text';
        text: string;
    }
}

export type AgentMessage = {
    id: string;
    localId: string | null;
    createdAt: number;
    role: 'agent';
    content: {
        type: 'text';
        text: string;
    } | {
        type: 'tool';
        tools: ToolCall[];
    }
}

export type Message = AgentMessage | UserMessage;
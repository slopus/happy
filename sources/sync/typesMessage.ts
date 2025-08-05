import { AgentEvent } from "./typesRaw";

export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: any;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;
}

// Flattened message types - each message represents a single block
export type UserTextMessage = {
    kind: 'user-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
}

export type ModeSwitchMessage = {
    kind: 'agent-event';
    id: string;
    createdAt: number;
    event: AgentEvent;  
}

export type AgentTextMessage = {
    kind: 'agent-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
}

export type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    localId: string | null;
    createdAt: number;
    tool: ToolCall;
    children: Message[];
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage;
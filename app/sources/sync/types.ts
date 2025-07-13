// Base message types
export type MessageType = 'human' | 'assistant';

// Human message content types
export interface HumanTextContent {
    type: 'human';
    content: {
        type: 'text';
        text: string;
    };
}

// Assistant message content types
export interface AssistantTextContent {
    type: 'assistant';
    content: {
        type: 'text';
        text: string;
    };
}

export interface AssistantCodeContent {
    type: 'assistant';
    content: {
        type: 'code';
        language: string; // e.g., 'javascript', 'python', 'typescript'
        code: string;
        filename?: string;
    };
}

export interface AssistantToolCallContent {
    type: 'assistant';
    content: {
        type: 'tool_call';
        tool: string; // Tool name
        arguments: Record<string, any>;
        result?: any;
    };
}

export interface AssistantToolResultContent {
    type: 'assistant';
    content: {
        type: 'tool_result';
        tool: string;
        result: any;
        error?: string;
    };
}

export interface AssistantThinkingContent {
    type: 'assistant';
    content: {
        type: 'thinking';
        thought: string;
    };
}

export interface AssistantErrorContent {
    type: 'assistant';
    content: {
        type: 'error';
        error: string;
        details?: any;
    };
}

// Union types for all content
export type HumanContent = 
    | HumanTextContent;

export type AssistantContent = 
    | AssistantTextContent
    | AssistantCodeContent
    | AssistantToolCallContent
    | AssistantToolResultContent
    | AssistantThinkingContent
    | AssistantErrorContent;

export type MessageContent = HumanContent | AssistantContent;

// Session and message interfaces
export interface Session {
    id: string;
    tag: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    lastMessage: DecryptedMessage | null;
}

export interface EncryptedMessage {
    id: string;
    seq: number;
    content: {
        t: 'encrypted';
        c: string; // Base64 encoded encrypted content
    };
    createdAt: number;
}

export interface DecryptedMessage {
    id: string;
    seq: number;
    content: MessageContent | null; // Decrypted content or null if decryption failed
    createdAt: number;
}

export interface SessionUpdate {
    id: string;
    seq: number;
    content: {
        t: 'new-message';
        sid: string; // Session ID
        mid: string; // Message ID
        c: string; // Encrypted content
    };
    createdAt: number;
}

// Helper type guards
export function isHumanContent(content: MessageContent): content is HumanContent {
    return content.type === 'human';
}

export function isAssistantContent(content: MessageContent): content is AssistantContent {
    return content.type === 'assistant';
}

export function isTextContent(content: MessageContent): content is (HumanTextContent | AssistantTextContent) {
    return content.content.type === 'text';
}

export function isCodeContent(content: MessageContent): content is AssistantCodeContent {
    return content.type === 'assistant' && content.content.type === 'code';
}

export function isToolCallContent(content: MessageContent): content is AssistantToolCallContent {
    return content.type === 'assistant' && content.content.type === 'tool_call';
}

export function isToolResultContent(content: MessageContent): content is AssistantToolResultContent {
    return content.type === 'assistant' && content.content.type === 'tool_result';
}

export function isThinkingContent(content: MessageContent): content is AssistantThinkingContent {
    return content.type === 'assistant' && content.content.type === 'thinking';
}

export function isErrorContent(content: MessageContent): content is AssistantErrorContent {
    return content.type === 'assistant' && content.content.type === 'error';
}
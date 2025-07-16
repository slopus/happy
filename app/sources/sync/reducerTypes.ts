//
// Claude Message Types
//

// Base content types
export interface ClaudeTextContent {
    type: 'text';
    text: string;
}

export interface ClaudeToolUseContent {
    type: 'tool_use';
    id: string;
    name: string;
    input: any; // Tool inputs vary greatly
}

export interface ClaudeToolResultContent {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}

export type ClaudeMessageContent = ClaudeTextContent | ClaudeToolUseContent | ClaudeToolResultContent;

// Usage information
export interface ClaudeUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
}

// Assistant message
export interface ClaudeAssistantMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: ClaudeMessageContent[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: ClaudeUsage;
}

// User message
export interface ClaudeUserMessage {
    role: 'user';
    content: ClaudeMessageContent[];
}

// System message
export interface ClaudeSystemMessage {
    type: 'system';
    subtype: string;
    cwd?: string;
    session_id?: string;
    tools?: string[];
    mcp_servers?: any[];
    model?: string;
    permissionMode?: string;
    apiKeySource?: string;
}

// Result message
export interface ClaudeResultMessage {
    type: 'result';
    subtype: string;
    is_error: boolean;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    result?: string;
    session_id?: string;
    total_cost_usd?: number;
    usage?: any;
}

// Output data types
export interface ClaudeAssistantOutputData {
    type: 'assistant';
    message: ClaudeAssistantMessage;
    parent_tool_use_id: string | null;
    session_id: string;
}

export interface ClaudeUserOutputData {
    type: 'user';
    message: ClaudeUserMessage;
    parent_tool_use_id: string | null;
    session_id: string;
}

export interface ClaudeSystemOutputData {
    type: 'system';
    // System messages don't have a message field
    parent_tool_use_id: string | null;
    session_id: string;
}

export type ClaudeOutputData = ClaudeAssistantOutputData | ClaudeUserOutputData | ClaudeSystemOutputData;

// Main agent content structure
export interface ClaudeAgentContent {
    type: 'output';
    data: ClaudeOutputData;
}
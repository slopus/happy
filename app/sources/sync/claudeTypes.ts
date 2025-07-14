//
// Claude Message Types
//

// Base content types
export interface TextContent {
    type: 'text';
    text: string;
}

export interface ToolUseContent {
    type: 'tool_use';
    id: string;
    name: string;
    input: any; // Tool inputs vary greatly
}

export interface ToolResultContent {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}

export type ClaudeMessageContent = TextContent | ToolUseContent | ToolResultContent;

// Usage information
export interface Usage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    service_tier?: string;
}

// Assistant message
export interface AssistantMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: ClaudeMessageContent[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: Usage;
}

// User message
export interface UserMessage {
    role: 'user';
    content: ClaudeMessageContent[];
}

// System message
export interface SystemMessage {
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
export interface ResultMessage {
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
export interface AssistantOutputData {
    type: 'assistant';
    message: AssistantMessage;
    parent_tool_use_id: string | null;
    session_id: string;
}

export interface UserOutputData {
    type: 'user';
    message: UserMessage;
    parent_tool_use_id: string | null;
    session_id: string;
}

export interface SystemOutputData {
    type: 'system';
    // System messages don't have a message field
    parent_tool_use_id: string | null;
    session_id: string;
}

export type OutputData = AssistantOutputData | UserOutputData | SystemOutputData;

// Main agent content structure
export interface ClaudeAgentContent {
    type: 'output';
    data: OutputData;
}
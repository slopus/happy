/**
 * Type definitions for Codex MCP integration
 */

/**
 * Image content for Codex/GPT format
 */
export interface CodexImageContent {
    type: 'image_url';
    image_url: {
        url: string;
    };
}

/**
 * Text content for Codex/GPT format
 */
export interface CodexTextContent {
    type: 'text';
    text: string;
}

export type CodexContent = CodexImageContent | CodexTextContent;

export interface CodexSessionConfig {
    prompt: string | CodexContent[];
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    'base-instructions'?: string;
    config?: Record<string, any>;
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: string;
    profile?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}

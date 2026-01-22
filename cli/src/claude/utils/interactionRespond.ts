import type { SDKUserMessage } from '@/claude/sdk';

export function createClaudeToolResultUserMessage(toolCallId: string, responseText: string): SDKUserMessage {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: toolCallId,
                    content: responseText,
                },
            ],
        },
    };
}

export async function handleClaudeInteractionRespond(opts: {
    toolCallId: string;
    responseText: string;
    approveToolCall: (toolCallId: string) => void | Promise<void>;
    pushToolResult: (message: SDKUserMessage) => void;
}): Promise<void> {
    await opts.approveToolCall(opts.toolCallId);
    opts.pushToolResult(createClaudeToolResultUserMessage(opts.toolCallId, opts.responseText));
}


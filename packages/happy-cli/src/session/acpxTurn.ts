import { randomUUID } from 'node:crypto';

import type {
    SessionAgentContent,
    SessionAgentMessage,
    SessionMessage,
    SessionToolResult,
    SessionToolResultContent,
    SessionUserContent,
    SessionUserMessage,
} from '@slopus/happy-sync';

import type { AgentMessage } from '@/agent/core';
import type { RawJSONLines } from '@/claude/types';

export type AcpxTurn = {
    message: { Agent: SessionAgentMessage };
    sent: boolean;
};

export function createAcpxTurn(): AcpxTurn {
    return {
        message: { Agent: { content: [], tool_results: {} } },
        sent: false,
    };
}

export function resetAcpxTurn(turn: AcpxTurn): void {
    turn.message.Agent.content = [];
    turn.message.Agent.tool_results = {};
    if ('reasoning_details' in turn.message.Agent) {
        delete turn.message.Agent.reasoning_details;
    }
    turn.sent = false;
}

export function hasAcpxTurnContent(turn: AcpxTurn): boolean {
    return (
        turn.message.Agent.content.length > 0
        || Object.keys(turn.message.Agent.tool_results).length > 0
    );
}

export function getUserMessageText(message: { User: SessionUserMessage }): string | null {
    const textBlock = message.User.content.find((content): content is Extract<SessionUserContent, { Text: string }> => 'Text' in content);
    return textBlock?.Text ?? null;
}

export function applyAgentMessageToAcpxTurn(turn: AcpxTurn, message: AgentMessage): void {
    switch (message.type) {
        case 'model-output':
            appendText(turn.message.Agent.content, message.textDelta ?? message.fullText ?? '');
            return;
        case 'tool-call':
            upsertToolUse(turn, {
                id: message.callId,
                name: message.toolName,
                input: message.args,
                rawInput: stringifyInput(message.args),
                isInputComplete: true,
            });
            return;
        case 'tool-result':
            upsertToolResult(turn, {
                callId: message.callId,
                toolName: message.toolName,
                output: message.result,
                isError: isToolError(message.result),
            });
            return;
        case 'event':
            if (message.name === 'thinking') {
                const thinkingText = extractThinkingText(message.payload);
                appendThinking(turn.message.Agent.content, thinkingText);
            }
            return;
        case 'terminal-output':
            appendText(turn.message.Agent.content, message.data);
            return;
        case 'fs-edit': {
            const callId = `fs-edit:${randomUUID()}`;
            upsertToolUse(turn, {
                id: callId,
                name: 'fs-edit',
                input: {
                    description: message.description,
                    path: message.path,
                    diff: message.diff,
                },
                rawInput: stringifyInput({
                    description: message.description,
                    path: message.path,
                    diff: message.diff,
                }),
                isInputComplete: true,
            });
            upsertToolResult(turn, {
                callId,
                toolName: 'fs-edit',
                output: message.description,
                isError: false,
            });
            return;
        }
        case 'permission-request':
        case 'permission-response':
        case 'token-count':
        case 'exec-approval-request':
        case 'patch-apply-begin':
        case 'patch-apply-end':
        case 'status':
            return;
    }
}

export function applyPseudoEventToAcpxTurn(turn: AcpxTurn, message: Record<string, unknown>): void {
    const type = typeof message.type === 'string' ? message.type : '';
    switch (type) {
        case 'message':
            appendText(turn.message.Agent.content, typeof message.message === 'string' ? message.message : '');
            return;
        case 'reasoning':
            appendThinking(turn.message.Agent.content, typeof message.message === 'string' ? message.message : '');
            return;
        case 'thinking':
            appendThinking(turn.message.Agent.content, typeof message.text === 'string' ? message.text : '');
            return;
        case 'tool-call':
            if (typeof message.callId !== 'string' || typeof message.name !== 'string') {
                return;
            }
            upsertToolUse(turn, {
                id: message.callId,
                name: message.name,
                input: message.input,
                rawInput: stringifyInput(message.input),
                isInputComplete: true,
            });
            return;
        case 'tool-call-result':
        case 'tool-result':
            if (typeof message.callId !== 'string') {
                return;
            }
            upsertToolResult(turn, {
                callId: message.callId,
                toolName: typeof message.toolName === 'string'
                    ? message.toolName
                    : findToolName(turn.message.Agent, message.callId),
                output: Object.prototype.hasOwnProperty.call(message, 'output') ? message.output : message.result,
                isError: Boolean(message.isError) || isToolError(Object.prototype.hasOwnProperty.call(message, 'output') ? message.output : message.result),
            });
            return;
        case 'file-edit': {
            const callId = typeof message.id === 'string' ? message.id : `file-edit:${randomUUID()}`;
            upsertToolUse(turn, {
                id: callId,
                name: 'file-edit',
                input: {
                    description: message.description,
                    filePath: message.filePath,
                    diff: message.diff,
                },
                rawInput: stringifyInput({
                    description: message.description,
                    filePath: message.filePath,
                    diff: message.diff,
                }),
                isInputComplete: true,
            });
            upsertToolResult(turn, {
                callId,
                toolName: 'file-edit',
                output: message.description,
                isError: false,
            });
            return;
        }
        default:
            return;
    }
}

export function applyClaudeAssistantMessageToAcpxTurn(turn: AcpxTurn, body: RawJSONLines): void {
    if (body.type !== 'assistant') {
        return;
    }

    const content = Array.isArray(body.message?.content) ? body.message.content : [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
            continue;
        }

        if (block.type === 'text' && typeof block.text === 'string') {
            appendText(turn.message.Agent.content, block.text);
            continue;
        }

        if (block.type === 'thinking') {
            const thinkingText = typeof block.thinking === 'string'
                ? block.thinking
                : typeof block.text === 'string'
                    ? block.text
                    : '';
            appendThinking(turn.message.Agent.content, thinkingText, typeof block.signature === 'string' ? block.signature : null);
            continue;
        }

        if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
            turn.message.Agent.content.push({ RedactedThinking: block.data });
            continue;
        }

        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            upsertToolUse(turn, {
                id: block.id,
                name: block.name,
                input: block.input,
                rawInput: stringifyInput(block.input),
                isInputComplete: true,
                thoughtSignature: typeof block.thought_signature === 'string' ? block.thought_signature : null,
            });
        }
    }
}

export function applyClaudeToolResultsToAcpxTurn(turn: AcpxTurn, body: RawJSONLines): boolean {
    if (body.type !== 'user') {
        return false;
    }

    const blocks = Array.isArray(body.message?.content) ? body.message.content : [];
    let foundToolResult = false;

    for (const block of blocks) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
            continue;
        }

        foundToolResult = true;
        upsertToolResult(turn, {
            callId: block.tool_use_id,
            toolName: findToolName(turn.message.Agent, block.tool_use_id),
            output: block.content,
            isError: block.is_error === true,
        });
    }

    return foundToolResult;
}

export function createClaudeUserMessage(body: RawJSONLines): { User: SessionUserMessage } | null {
    if (body.type !== 'user') {
        return null;
    }

    const content = toSessionUserContent(body.message?.content);
    if (content.length === 0) {
        return null;
    }

    return {
        User: {
            id: body.uuid,
            content,
        },
    };
}

function appendText(content: SessionAgentContent[], text: string): void {
    if (!text) {
        return;
    }

    const last = content.at(-1);
    if (last && 'Text' in last) {
        last.Text += text;
        return;
    }

    content.push({ Text: text });
}

function appendThinking(content: SessionAgentContent[], text: string, signature?: string | null): void {
    if (!text) {
        return;
    }

    const last = content.at(-1);
    if (last && 'Thinking' in last && (last.Thinking.signature ?? null) === (signature ?? null)) {
        last.Thinking.text += text;
        return;
    }

    content.push({
        Thinking: {
            text,
            ...(signature === undefined ? {} : { signature }),
        },
    });
}

function upsertToolUse(
    turn: AcpxTurn,
    tool: {
        id: string;
        name: string;
        input: unknown;
        rawInput: string;
        isInputComplete: boolean;
        thoughtSignature?: string | null;
    },
): void {
    const existing = turn.message.Agent.content.find(
        (content): content is Extract<SessionAgentContent, { ToolUse: { id: string } }> => 'ToolUse' in content && content.ToolUse.id === tool.id,
    );

    if (existing) {
        existing.ToolUse.name = tool.name;
        existing.ToolUse.input = tool.input;
        existing.ToolUse.raw_input = tool.rawInput;
        existing.ToolUse.is_input_complete = tool.isInputComplete;
        if (tool.thoughtSignature !== undefined) {
            existing.ToolUse.thought_signature = tool.thoughtSignature;
        }
        return;
    }

    turn.message.Agent.content.push({
        ToolUse: {
            id: tool.id,
            name: tool.name,
            input: tool.input,
            raw_input: tool.rawInput,
            is_input_complete: tool.isInputComplete,
            ...(tool.thoughtSignature === undefined ? {} : { thought_signature: tool.thoughtSignature }),
        },
    });
}

function upsertToolResult(
    turn: AcpxTurn,
    tool: {
        callId: string;
        toolName: string;
        output: unknown;
        isError: boolean;
    },
): void {
    const content = toToolResultContent(tool.output);
    const result: SessionToolResult = {
        tool_use_id: tool.callId,
        tool_name: tool.toolName,
        is_error: tool.isError,
        content,
        ...(tool.output === undefined ? {} : { output: tool.output }),
    };
    turn.message.Agent.tool_results[tool.callId] = result;
}

function toToolResultContent(output: unknown): SessionToolResultContent {
    if (typeof output === 'string') {
        return { Text: output };
    }

    if (Array.isArray(output)) {
        return { Text: stringifyInput(output) };
    }

    if (output && typeof output === 'object' && 'Text' in (output as Record<string, unknown>) && typeof (output as { Text?: unknown }).Text === 'string') {
        return { Text: (output as { Text: string }).Text };
    }

    return { Text: stringifyInput(output) };
}

function toSessionUserContent(input: unknown): SessionUserContent[] {
    if (typeof input === 'string') {
        return input ? [{ Text: input }] : [];
    }

    if (!Array.isArray(input)) {
        return [];
    }

    const content: SessionUserContent[] = [];
    for (const block of input) {
        if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
            continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
            content.push({ Text: block.text });
        }
    }
    return content;
}

function stringifyInput(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }

    try {
        return JSON.stringify(input ?? {}, null, 2);
    } catch {
        return String(input);
    }
}

function extractThinkingText(payload: unknown): string {
    if (typeof payload === 'string') {
        return payload;
    }

    if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
        return (payload as { text: string }).text;
    }

    return '';
}

function isToolError(result: unknown): boolean {
    return Boolean(
        result
        && typeof result === 'object'
        && 'error' in result
        && (result as { error?: unknown }).error,
    );
}

function findToolName(message: SessionAgentMessage, callId: string): string {
    const toolUse = message.content.find(
        (content): content is Extract<SessionAgentContent, { ToolUse: { id: string } }> => 'ToolUse' in content && content.ToolUse.id === callId,
    );
    return toolUse?.ToolUse.name ?? 'tool';
}

/**
 * v3 Protocol Converter
 *
 * Converts v3 ProtocolEnvelope messages (Message + Parts) into the app's
 * flat Message[] format for the store.
 *
 * This converter runs at ingestion time: decrypt → detect v3 → convert → store.
 * The store only holds the flat Message format. Rendering has one code path.
 *
 * Legacy messages go through the existing normalizeRawMessage → reducer pipeline.
 * v3 messages bypass the reducer entirely — the canonical format already has
 * all the structure we need.
 */

import type { Message, ToolCall, UserTextMessage, AgentTextMessage, ToolCallMessage } from './typesMessage';
import type { v3 } from '@slopus/happy-wire';

type MessageWithParts = v3.MessageWithParts;
type Part = v3.Part;

/**
 * Detect if a decrypted payload is a v3 protocol envelope.
 */
export function isV3Envelope(payload: unknown): payload is { v: 3; message: MessageWithParts } {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    return p.v === 3 && p.message !== null && typeof p.message === 'object';
}

/**
 * Convert a v3 MessageWithParts into the app's flat Message[] format.
 *
 * One v3 message can produce multiple app messages:
 * - A user message produces one UserTextMessage
 * - An assistant message produces AgentTextMessages + ToolCallMessages
 */
export function convertV3ToAppMessages(envelope: { v: 3; message: MessageWithParts }): Message[] {
    const { info, parts } = envelope.message;

    if (info.role === 'user') {
        return convertUserMessage(info, parts);
    }

    if (info.role === 'assistant') {
        return convertAssistantMessage(info, parts);
    }

    return [];
}

// ─── User ─────────────────────────────────────────────────────────────────────

function convertUserMessage(info: v3.UserMessage, parts: Part[]): Message[] {
    const textParts = parts.filter((p): p is v3.TextPart => p.type === 'text' && !p.synthetic);
    const text = textParts.map(p => p.text).join('\n');

    if (text.trim().length === 0) return [];

    const msg: UserTextMessage = {
        kind: 'user-text',
        id: info.id,
        localId: null,
        createdAt: info.time.created,
        text,
    };
    return [msg];
}

// ─── Assistant ────────────────────────────────────────────────────────────────

function convertAssistantMessage(info: v3.AssistantMessage, parts: Part[]): Message[] {
    const messages: Message[] = [];

    for (const part of parts) {
        // Skip structural parts
        if (part.type === 'step-start' || part.type === 'step-finish') continue;
        if (part.type === 'snapshot' || part.type === 'patch') continue;
        if (part.type === 'compaction' || part.type === 'retry') continue;
        if (part.type === 'agent' || part.type === 'subtask') continue;

        if (part.type === 'text') {
            const msg: AgentTextMessage = {
                kind: 'agent-text',
                id: part.id,
                localId: null,
                createdAt: info.time.created,
                text: part.text,
                isThinking: false,
            };
            messages.push(msg);
            continue;
        }

        if (part.type === 'reasoning') {
            const msg: AgentTextMessage = {
                kind: 'agent-text',
                id: part.id,
                localId: null,
                createdAt: info.time.created,
                text: part.text,
                isThinking: true,
            };
            messages.push(msg);
            continue;
        }

        if (part.type === 'tool') {
            const toolCall = convertToolPart(part);
            const msg: ToolCallMessage = {
                kind: 'tool-call',
                id: part.id,
                localId: null,
                createdAt: info.time.created,
                tool: toolCall,
                children: [],
            };
            messages.push(msg);
            continue;
        }

        if (part.type === 'file') {
            // File parts from assistant are rendered as text with attachment info
            const msg: AgentTextMessage = {
                kind: 'agent-text',
                id: part.id,
                localId: null,
                createdAt: info.time.created,
                text: `[Attached ${part.mime}: ${part.filename ?? 'file'}]`,
            };
            messages.push(msg);
            continue;
        }
    }

    return messages;
}

// ─── Tool conversion ──────────────────────────────────────────────────────────

function convertToolPart(part: v3.ToolPart): ToolCall {
    const state = part.state;
    const base = {
        name: part.tool,
        input: state.input,
        createdAt: Date.now(),
        startedAt: 'time' in state && state.time ? (state.time as { start: number }).start : null,
        completedAt: null as number | null,
        description: null as string | null,
        result: undefined as unknown,
        permission: undefined as ToolCall['permission'],
    };

    switch (state.status) {
        case 'pending':
            return { ...base, state: 'running' };

        case 'running':
            return {
                ...base,
                state: 'running',
                description: state.title ?? null,
            };

        case 'blocked': {
            const block = state.block;
            const permission: ToolCall['permission'] = block.type === 'permission'
                ? {
                    id: block.id,
                    status: 'pending',
                    reason: typeof (block.metadata as any)?.reason === 'string'
                        ? (block.metadata as any).reason
                        : undefined,
                }
                : {
                    id: block.id,
                    status: 'pending',
                };
            return {
                ...base,
                state: 'running', // UI treats blocked as running with permission pending
                description: state.title ?? null,
                permission,
            };
        }

        case 'completed': {
            const permission = convertResolvedBlock(state.block);
            return {
                ...base,
                state: 'completed',
                description: state.title,
                result: state.output,
                completedAt: state.time.end,
                permission,
            };
        }

        case 'error': {
            const permission = convertResolvedBlock(state.block);
            return {
                ...base,
                state: 'error',
                result: state.error,
                completedAt: state.time.end,
                permission,
            };
        }
    }
}

function convertResolvedBlock(block: v3.ResolvedBlock | undefined): ToolCall['permission'] {
    if (!block) return undefined;

    if (block.type === 'permission') {
        const decision = block.decision;
        return {
            id: block.id,
            status: decision === 'reject' ? 'denied' : 'approved',
            decision: decision === 'once' ? 'approved'
                : decision === 'always' ? 'approved_for_session'
                : 'denied',
            date: block.decidedAt,
        };
    }

    // Question blocks don't map to the current permission model
    // but we preserve the ID for tracking
    if (block.type === 'question') {
        return {
            id: block.id,
            status: 'approved',
            date: block.decidedAt,
        };
    }

    return undefined;
}

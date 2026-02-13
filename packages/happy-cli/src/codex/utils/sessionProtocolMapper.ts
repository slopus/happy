import { randomUUID } from 'node:crypto';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@/sessionProtocol/types';

export type CodexTurnState = {
    currentTurnId: string | null;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

type LegacyToolLikeMessage = {
    type: 'tool-call' | 'tool-call-result';
    callId: string;
    name?: string;
    input?: unknown;
    output?: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
};

function buildEnvelopeOptions(currentTurnId: string | null, invoke?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(invoke ? { invoke } : {}),
    };
}

function pickInvoke(message: Record<string, unknown>): string | undefined {
    const candidates = [message.invoke, message.parent_call_id, message.parentCallId];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}

function pickCallId(message: Record<string, unknown>): string {
    const callId = message.call_id ?? message.callId;
    if (typeof callId === 'string' && callId.length > 0) {
        return callId;
    }
    return randomUUID();
}

function summarizeCommand(command: unknown): string | null {
    if (typeof command === 'string' && command.trim().length > 0) {
        return command;
    }
    if (Array.isArray(command)) {
        const cmd = command.map(v => String(v)).join(' ').trim();
        return cmd.length > 0 ? cmd : null;
    }
    return null;
}

function commandToTitle(command: string | null): string {
    if (!command) {
        return 'Run command';
    }
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return `Run \`${short}\``;
}

function patchDescription(changes: unknown): string {
    if (!changes || typeof changes !== 'object') {
        return 'Applying patch';
    }
    const fileCount = Object.keys(changes as Record<string, unknown>).length;
    if (fileCount === 1) {
        return 'Applying patch to 1 file';
    }
    return `Applying patch to ${fileCount} files`;
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;

    if (type === 'task_started') {
        const turnStart = createEnvelope('agent', { t: 'turn-start' });
        return {
            currentTurnId: turnStart.id,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                envelopes: [],
            };
        }

        return {
            currentTurnId: null,
            envelopes: [
                createEnvelope('agent', { t: 'turn-end' }, { turn: state.currentTurnId })
            ],
        };
    }

    if (type === 'token_count') {
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [],
        };
    }

    const invoke = pickInvoke(message);
    const opts = buildEnvelopeOptions(state.currentTurnId, invoke);

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return { currentTurnId: state.currentTurnId, envelopes: [] };
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes: [createEnvelope('agent', { t: 'text', text: message.message }, opts)],
        };
    }

    if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
        const text = typeof message.text === 'string'
            ? message.text
            : (typeof message.delta === 'string' ? message.delta : null);

        if (!text) {
            return { currentTurnId: state.currentTurnId, envelopes: [] };
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes: [createEnvelope('agent', { t: 'text', text, thinking: true }, opts)],
        };
    }

    if (type === 'exec_command_begin' || type === 'exec_approval_request') {
        const call = pickCallId(message);
        const { call_id: _callIdSnake, callId: _callIdCamel, type: _type, ...args } = message;

        const command = summarizeCommand((args as Record<string, unknown>).command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        return {
            currentTurnId: state.currentTurnId,
            envelopes: [
                createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name: 'CodexBash',
                    title: commandToTitle(command),
                    description,
                    args: args as Record<string, unknown>,
                }, opts)
            ],
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [createEnvelope('agent', { t: 'tool-call-end', call }, opts)],
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        return {
            currentTurnId: state.currentTurnId,
            envelopes: [
                createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name: 'CodexPatch',
                    title: 'Apply patch',
                    description: patchDescription(changes),
                    args: {
                        auto_approved: autoApproved,
                        changes,
                    },
                }, opts)
            ],
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [createEnvelope('agent', { t: 'tool-call-end', call }, opts)],
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        envelopes: [],
    };
}

export function mapCodexProcessorMessageToSessionEnvelopes(
    message: ReasoningOutput | DiffToolCall | DiffToolResult,
    state: CodexTurnState,
): SessionEnvelope[] {
    const toolLikeMessage = message as LegacyToolLikeMessage;
    const opts = buildEnvelopeOptions(state.currentTurnId);

    if (message.type === 'reasoning') {
        return [createEnvelope('agent', {
            t: 'text',
            text: message.message,
            thinking: true,
        }, opts)];
    }

    if (message.type === 'tool-call') {
        const title = typeof (toolLikeMessage.input as { title?: unknown } | undefined)?.title === 'string'
            ? (toolLikeMessage.input as { title: string }).title
            : `${toolLikeMessage.name || 'Tool'} call`;

        return [createEnvelope('agent', {
            t: 'tool-call-start',
            call: toolLikeMessage.callId,
            name: toolLikeMessage.name || 'unknown',
            title,
            description: title,
            args: (toolLikeMessage.input && typeof toolLikeMessage.input === 'object'
                ? toolLikeMessage.input
                : {}) as Record<string, unknown>,
        }, opts)];
    }

    if (message.type === 'tool-call-result') {
        const envelopes: SessionEnvelope[] = [];
        const content = toolLikeMessage.output?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            envelopes.push(createEnvelope('agent', {
                t: 'text',
                text: content,
                thinking: true,
            }, opts));
        }
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call: toolLikeMessage.callId,
        }, opts));
        return envelopes;
    }

    return [];
}

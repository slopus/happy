/**
 * v3 OpenClaw Mapper — converts OpenClaw AgentMessage events into the v3
 * Message + Parts canonical format.
 *
 * OpenClaw events arrive via the OpenClawBackend as typed AgentMessage objects:
 * - model-output  → text part (accumulated, streamed)
 * - event(thinking) → reasoning part (accumulated or immediate)
 * - tool-call     → tool part (running)
 * - tool-result   → tool part (completed/error)
 * - status        → ignored (lifecycle only, tracked by runner for keep-alive)
 *
 * Follows the same stateless-mapper pattern as the Gemini and Claude v3 mappers.
 */

import { createId } from '@paralleldrive/cuid2';
import { v3 } from '@slopus/happy-sync';
import type { AgentMessage } from '@/agent/core';

type MessageWithParts = v3.MessageWithParts;
type Part = v3.Part;
type AssistantMessage = v3.AssistantMessage;
type TextPart = v3.TextPart;
type ReasoningPart = v3.ReasoningPart;
type ToolPart = v3.ToolPart;
type StepFinishPart = v3.StepFinishPart;
type MessageID = v3.MessageID;
type SessionID = v3.SessionID;
type PartID = v3.PartID;

// ─── ID helpers ───────────────────────────────────────────────────────────────

function msgId(): MessageID { return `msg_${createId()}` as MessageID; }
function partId(): PartID { return `prt_${createId()}` as PartID; }

// ─── State ────────────────────────────────────────────────────────────────────

export type V3OpenClawMapperState = {
    sessionID: SessionID;
    agent: string;
    modelID: string;
    providerID: string;
    cwd: string;
    root: string;

    currentAssistant: {
        info: AssistantMessage;
        parts: Part[];
    } | null;

    currentUserMessageID: MessageID | null;
    toolParts: Map<string, ToolPart>;

    /** Pending text waiting to be flushed when the stream type changes */
    pendingText: string;
    pendingType: 'thinking' | 'output' | null;
};

export function createV3OpenClawMapperState(opts: {
    sessionID: string;
    agent?: string;
    modelID?: string;
    providerID?: string;
    cwd?: string;
    root?: string;
}): V3OpenClawMapperState {
    return {
        sessionID: opts.sessionID as SessionID,
        agent: opts.agent ?? 'openclaw',
        modelID: opts.modelID ?? 'openclaw',
        providerID: opts.providerID ?? 'openclaw',
        cwd: opts.cwd ?? process.cwd(),
        root: opts.root ?? process.cwd(),
        currentAssistant: null,
        currentUserMessageID: null,
        toolParts: new Map(),
        pendingText: '',
        pendingType: null,
    };
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type V3OpenClawMapperResult = {
    messages: MessageWithParts[];
    currentAssistant: MessageWithParts | null;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

export function handleOpenClawMessage(
    msg: AgentMessage,
    state: V3OpenClawMapperState,
): V3OpenClawMapperResult {
    const result: V3OpenClawMapperResult = { messages: [], currentAssistant: null };

    if (msg.type === 'status') {
        // Status messages are lifecycle-only — tracked by the runner for keep-alive.
        result.currentAssistant = snapshot(state);
        return result;
    }

    // Ensure we have an assistant message for content events
    if (!state.currentAssistant) {
        startAssistant(state);
    }
    const asst = state.currentAssistant!;

    if (msg.type === 'event' && msg.name === 'thinking') {
        const { text, streaming } = parseThinkingPayload(msg.payload);
        if (!text) {
            result.currentAssistant = snapshot(state);
            return result;
        }

        if (streaming) {
            flushIfTypeChanged(state, 'thinking', asst);
            state.pendingType = 'thinking';
            state.pendingText += text;
        } else {
            flushPending(state, asst);
            const trimmed = text.replace(/^\n+|\n+$/g, '');
            if (trimmed) {
                asst.parts.push({
                    id: partId(),
                    sessionID: state.sessionID,
                    messageID: asst.info.id,
                    type: 'reasoning',
                    text: trimmed,
                    time: { start: Date.now() },
                } satisfies ReasoningPart);
            }
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (msg.type === 'model-output') {
        const text = msg.textDelta ?? msg.fullText ?? '';
        if (text) {
            flushIfTypeChanged(state, 'output', asst);
            state.pendingType = 'output';
            state.pendingText += text;
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (msg.type === 'tool-call') {
        flushPending(state, asst);

        const callID = msg.callId || `call_${createId()}`;
        const toolName = msg.toolName || 'tool';

        const toolPart: ToolPart = {
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'tool',
            callID,
            tool: toolName,
            state: {
                status: 'running',
                input: msg.args ?? {},
                title: toolName,
                time: { start: Date.now() },
            },
        };
        asst.parts.push(toolPart);
        state.toolParts.set(callID, toolPart);
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (msg.type === 'tool-result') {
        flushPending(state, asst);

        const callID = msg.callId || '';
        const toolPart = state.toolParts.get(callID);
        if (toolPart && (toolPart.state.status === 'running' || toolPart.state.status === 'blocked')) {
            const content = typeof msg.result === 'string'
                ? msg.result
                : (msg.result != null ? JSON.stringify(msg.result) : '');

            toolPart.state = {
                status: 'completed',
                input: toolPart.state.input,
                output: content,
                title: ('title' in toolPart.state && toolPart.state.title) ? toolPart.state.title : toolPart.tool,
                metadata: {},
                time: { start: toolPart.state.time.start, end: Date.now() },
            };
            state.toolParts.delete(callID);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (msg.type === 'terminal-output') {
        flushPending(state, asst);

        if (msg.data) {
            asst.parts.push({
                id: partId(),
                sessionID: state.sessionID,
                messageID: asst.info.id,
                type: 'text',
                text: msg.data,
                synthetic: true,
                time: { start: Date.now() },
            } satisfies TextPart);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (msg.type === 'fs-edit') {
        flushPending(state, asst);

        const callID = `edit_${createId()}`;
        const toolPart: ToolPart = {
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'tool',
            callID,
            tool: 'edit',
            state: {
                status: 'completed',
                input: { path: msg.path ?? 'unknown', description: msg.description },
                output: msg.diff ?? '',
                title: `Edit ${msg.path ?? 'file'}`,
                metadata: msg.path ? { filePath: msg.path } : {},
                time: { start: Date.now(), end: Date.now() },
            },
        };
        asst.parts.push(toolPart);
        result.currentAssistant = snapshot(state);
        return result;
    }

    // Unknown/unhandled event — pass through
    result.currentAssistant = snapshot(state);
    return result;
}

// ─── Turn lifecycle ──────────────────────────────────────────────────────────

export function startOpenClawTurn(state: V3OpenClawMapperState): V3OpenClawMapperResult {
    const result: V3OpenClawMapperResult = { messages: [], currentAssistant: null };
    if (state.currentAssistant) {
        finalizeAssistant(state, result, 'completed');
    }
    startAssistant(state);
    result.currentAssistant = snapshot(state);
    return result;
}

export function endOpenClawTurn(
    state: V3OpenClawMapperState,
    status: 'completed' | 'failed' | 'cancelled',
): V3OpenClawMapperResult {
    const result: V3OpenClawMapperResult = { messages: [], currentAssistant: null };
    if (state.currentAssistant) {
        finalizeAssistant(state, result, status);
    }
    return result;
}

export function flushV3OpenClawTurn(state: V3OpenClawMapperState): MessageWithParts[] {
    const result: V3OpenClawMapperResult = { messages: [], currentAssistant: null };
    if (state.currentAssistant) {
        finalizeAssistant(state, result, 'completed');
    }
    return result.messages;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
    if (typeof payload === 'string') {
        return { text: payload, streaming: false };
    }
    if (!payload || typeof payload !== 'object') {
        return { text: '', streaming: false };
    }
    const text = typeof (payload as { text?: unknown }).text === 'string'
        ? (payload as { text: string }).text
        : '';
    const streaming = (payload as { streaming?: unknown }).streaming === true;
    return { text, streaming };
}

function flushPending(
    state: V3OpenClawMapperState,
    asst: { info: AssistantMessage; parts: Part[] },
): void {
    if (!state.pendingText || !state.pendingType) return;

    const text = state.pendingText.replace(/^\n+|\n+$/g, '');
    const type = state.pendingType;
    state.pendingText = '';
    state.pendingType = null;

    if (!text) return;

    if (type === 'thinking') {
        asst.parts.push({
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'reasoning',
            text,
            time: { start: Date.now() },
        } satisfies ReasoningPart);
    } else {
        asst.parts.push({
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'text',
            text,
            time: { start: Date.now() },
        } satisfies TextPart);
    }
}

function flushIfTypeChanged(
    state: V3OpenClawMapperState,
    newType: 'thinking' | 'output',
    asst: { info: AssistantMessage; parts: Part[] },
): void {
    if (state.pendingType && state.pendingType !== newType) {
        flushPending(state, asst);
    }
}

function startAssistant(state: V3OpenClawMapperState): void {
    const id = msgId();
    state.currentAssistant = {
        info: {
            id,
            sessionID: state.sessionID,
            role: 'assistant' as const,
            time: { created: Date.now() },
            parentID: state.currentUserMessageID ?? ('' as MessageID),
            modelID: state.modelID,
            providerID: state.providerID,
            agent: state.agent,
            path: { cwd: state.cwd, root: state.root },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{
            id: partId(),
            sessionID: state.sessionID,
            messageID: id,
            type: 'step-start',
        } as Part],
    };
}

function finalizeAssistant(
    state: V3OpenClawMapperState,
    result: V3OpenClawMapperResult,
    reason: string,
): void {
    const asst = state.currentAssistant;
    if (!asst) return;

    // Flush any pending streamed text
    flushPending(state, asst);

    const finish: StepFinishPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'step-finish',
        reason,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    asst.parts.push(finish);

    asst.info.time.completed = Date.now();

    result.messages.push(v3.MessageWithPartsSchema.parse({ info: asst.info, parts: asst.parts }));
    state.currentAssistant = null;
    state.toolParts.clear();
}

function snapshot(state: V3OpenClawMapperState): MessageWithParts | null {
    if (!state.currentAssistant) return null;
    return {
        info: state.currentAssistant.info,
        parts: state.currentAssistant.parts,
    };
}

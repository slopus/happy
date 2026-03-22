/**
 * v3 Gemini Mapper — converts Gemini AgentMessage events into the v3
 * Message + Parts canonical format.
 *
 * Gemini events arrive as typed messages via sendAgentMessage('gemini', data):
 * - task_started → begin a new assistant turn
 * - message → text part
 * - thinking → reasoning part
 * - tool-call → tool part (running)
 * - tool-result → tool part (completed/error)
 * - file-edit → tool part (edit, completed immediately)
 * - permission-request → tool part (blocked)
 * - token_count → accumulate cost/token metadata
 * - task_complete / turn_aborted → finalize turn
 */

import { createId } from '@paralleldrive/cuid2';
import { v3 } from '@slopus/happy-sync';

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

export type V3GeminiMapperState = {
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

    turnTokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    turnCost: number;
};

export function createV3GeminiMapperState(opts: {
    sessionID: string;
    agent?: string;
    modelID?: string;
    providerID?: string;
    cwd?: string;
    root?: string;
}): V3GeminiMapperState {
    return {
        sessionID: opts.sessionID as SessionID,
        agent: opts.agent ?? 'build',
        modelID: opts.modelID ?? 'gemini-2.5-pro',
        providerID: opts.providerID ?? 'google',
        cwd: opts.cwd ?? process.cwd(),
        root: opts.root ?? process.cwd(),
        currentAssistant: null,
        currentUserMessageID: null,
        toolParts: new Map(),
        turnTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        turnCost: 0,
    };
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type V3GeminiMapperResult = {
    messages: MessageWithParts[];
    currentAssistant: MessageWithParts | null;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

export function handleGeminiMessage(
    event: Record<string, unknown>,
    state: V3GeminiMapperState,
): V3GeminiMapperResult {
    const result: V3GeminiMapperResult = { messages: [], currentAssistant: null };
    const type = event.type;

    if (type === 'task_started') {
        if (state.currentAssistant) {
            finalizeAssistant(state, result, 'completed');
        }
        startAssistant(state);
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (state.currentAssistant) {
            const status = type === 'task_complete' ? 'completed' : 'cancelled';
            finalizeAssistant(state, result, status);
        }
        return result;
    }

    if (type === 'token_count') {
        if (typeof event.input_tokens === 'number') state.turnTokens.input += event.input_tokens;
        if (typeof event.output_tokens === 'number') state.turnTokens.output += event.output_tokens;
        return result;
    }

    // Ensure we have an assistant message
    if (!state.currentAssistant) {
        startAssistant(state);
    }
    const asst = state.currentAssistant!;

    if (type === 'message') {
        const text = typeof event.message === 'string' ? event.message : '';
        if (text.length > 0) {
            asst.parts.push({
                id: partId(),
                sessionID: state.sessionID,
                messageID: asst.info.id,
                type: 'text',
                text,
                time: { start: Date.now() },
            } satisfies TextPart);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'thinking') {
        const text = typeof event.text === 'string' ? event.text : '';
        if (text.length > 0) {
            asst.parts.push({
                id: partId(),
                sessionID: state.sessionID,
                messageID: asst.info.id,
                type: 'reasoning',
                text,
                time: { start: Date.now() },
            } satisfies ReasoningPart);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'tool-call') {
        const callID = typeof event.callId === 'string' ? event.callId : `call_${createId()}`;
        const toolName = typeof event.name === 'string' && event.name.length > 0
            ? event.name
            : 'tool';
        const input = event.input && typeof event.input === 'object'
            ? event.input as Record<string, unknown>
            : {};

        const toolPart: ToolPart = {
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'tool',
            callID,
            tool: toolName,
            state: {
                status: 'running',
                input,
                title: toolName,
                time: { start: Date.now() },
            },
        };
        asst.parts.push(toolPart);
        state.toolParts.set(callID, toolPart);
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'tool-result') {
        const callID = typeof event.callId === 'string' ? event.callId : '';
        const toolPart = state.toolParts.get(callID);
        if (toolPart && (toolPart.state.status === 'running' || toolPart.state.status === 'blocked')) {
            const output = event.output;
            const isError = event.isError === true || event.is_error === true;
            const content = typeof output === 'string'
                ? output
                : (output != null ? JSON.stringify(output) : '');

            const resolvedBlock = toolPart.state.status === 'blocked'
                ? resolveBlock(toolPart)
                : undefined;

            if (isError) {
                toolPart.state = {
                    status: 'error',
                    input: toolPart.state.input,
                    error: content || 'Tool execution failed',
                    metadata: {},
                    time: { start: toolPart.state.time.start, end: Date.now() },
                    block: resolvedBlock,
                };
            } else {
                toolPart.state = {
                    status: 'completed',
                    input: toolPart.state.input,
                    output: content,
                    title: ('title' in toolPart.state && toolPart.state.title) ? toolPart.state.title : toolPart.tool,
                    metadata: {},
                    time: { start: toolPart.state.time.start, end: Date.now() },
                    block: resolvedBlock,
                };
            }
            state.toolParts.delete(callID);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'file-edit') {
        // File edits create a tool part that's immediately completed
        const callID = typeof event.id === 'string' ? event.id : `edit_${createId()}`;
        const filePath = typeof event.filePath === 'string' ? event.filePath : 'unknown';
        const description = typeof event.description === 'string' ? event.description : 'Edit file';
        const diff = typeof event.diff === 'string' ? event.diff : '';

        const toolPart: ToolPart = {
            id: partId(),
            sessionID: state.sessionID,
            messageID: asst.info.id,
            type: 'tool',
            callID,
            tool: 'edit',
            state: {
                status: 'completed',
                input: { filePath, description },
                output: diff,
                title: `Edit ${filePath}`,
                metadata: { filePath },
                time: { start: Date.now(), end: Date.now() },
            },
        };
        asst.parts.push(toolPart);
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'terminal-output') {
        // Terminal output appended as text
        const data = typeof event.data === 'string' ? event.data : '';
        if (data.length > 0) {
            asst.parts.push({
                id: partId(),
                sessionID: state.sessionID,
                messageID: asst.info.id,
                type: 'text',
                text: data,
                synthetic: true,
                time: { start: Date.now() },
            } satisfies TextPart);
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    if (type === 'permission-request') {
        const permissionId = typeof event.permissionId === 'string' ? event.permissionId : `perm_${createId()}`;
        const callID = typeof event.callId === 'string' ? event.callId : '';
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
        const description = typeof event.description === 'string' ? event.description : '';

        const toolPart = state.toolParts.get(callID);
        if (toolPart && toolPart.state.status === 'running') {
            toolPart.state = {
                status: 'blocked',
                input: toolPart.state.input,
                title: toolPart.state.title,
                metadata: toolPart.state.metadata,
                time: toolPart.state.time,
                block: {
                    type: 'permission',
                    id: permissionId,
                    permission: toolName,
                    patterns: [],
                    always: [],
                    metadata: { description },
                },
            };
        }
        result.currentAssistant = snapshot(state);
        return result;
    }

    // Unknown event type — ignore
    result.currentAssistant = snapshot(state);
    return result;
}

// ─── Flush ────────────────────────────────────────────────────────────────────

export function flushV3GeminiTurn(state: V3GeminiMapperState): MessageWithParts[] {
    const result: V3GeminiMapperResult = { messages: [], currentAssistant: null };
    if (state.currentAssistant) {
        finalizeAssistant(state, result, 'completed');
    }
    return result.messages;
}

// ─── Permission helpers ───────────────────────────────────────────────────────

export function blockToolForPermission(
    state: V3GeminiMapperState,
    callID: string,
    permissionId: string,
    permission: string,
    patterns: string[],
    metadata: Record<string, unknown>,
): MessageWithParts | null {
    const toolPart = state.toolParts.get(callID);
    if (!toolPart || toolPart.state.status !== 'running') return null;

    toolPart.state = {
        status: 'blocked',
        input: toolPart.state.input,
        title: toolPart.state.title,
        metadata: toolPart.state.metadata,
        time: toolPart.state.time,
        block: {
            type: 'permission',
            id: permissionId,
            permission,
            patterns,
            always: [],
            metadata,
        },
    };
    return snapshot(state);
}

export function unblockToolApproved(
    state: V3GeminiMapperState,
    callID: string,
    decision: 'once' | 'always',
): MessageWithParts | null {
    const toolPart = state.toolParts.get(callID);
    if (!toolPart || toolPart.state.status !== 'blocked') return null;

    const block = toolPart.state.block;
    toolPart.state = {
        status: 'running',
        input: toolPart.state.input,
        title: toolPart.state.title,
        metadata: { ...toolPart.state.metadata, resolvedBlock: { ...block, decision, decidedAt: Date.now() } },
        time: toolPart.state.time,
    };
    return snapshot(state);
}

export function unblockToolRejected(
    state: V3GeminiMapperState,
    callID: string,
    reason?: string,
): MessageWithParts | null {
    const toolPart = state.toolParts.get(callID);
    if (!toolPart || toolPart.state.status !== 'blocked') return null;

    const block = toolPart.state.block;
    const resolvedBlock: v3.ResolvedBlock | undefined = block.type === 'permission'
        ? { ...block, decision: 'reject' as const, decidedAt: Date.now() }
        : undefined;
    toolPart.state = {
        status: 'error',
        input: toolPart.state.input,
        error: reason || 'Permission denied',
        metadata: {},
        time: { start: toolPart.state.time.start, end: Date.now() },
        block: resolvedBlock,
    };
    state.toolParts.delete(callID);
    return snapshot(state);
}

// ─── Internals ────────────────────────────────────────────────────────────────

function startAssistant(state: V3GeminiMapperState): void {
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
    state.turnTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    state.turnCost = 0;
}

function finalizeAssistant(
    state: V3GeminiMapperState,
    result: V3GeminiMapperResult,
    reason: string,
): void {
    const asst = state.currentAssistant;
    if (!asst) return;

    const finish: StepFinishPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'step-finish',
        reason,
        cost: state.turnCost,
        tokens: { ...state.turnTokens },
    };
    asst.parts.push(finish);

    asst.info.cost = state.turnCost;
    asst.info.tokens = { ...state.turnTokens };
    asst.info.time.completed = Date.now();

    result.messages.push(validateMessageWithParts({ info: asst.info, parts: asst.parts }));
    state.currentAssistant = null;
    state.toolParts.clear();
}

/** Validate a finalized message against the v3 schema. Throws on invalid data. */
function validateMessageWithParts(msg: MessageWithParts): MessageWithParts {
    return v3.MessageWithPartsSchema.parse(msg);
}

function snapshot(state: V3GeminiMapperState): MessageWithParts | null {
    if (!state.currentAssistant) return null;
    return {
        info: state.currentAssistant.info,
        parts: state.currentAssistant.parts,
    };
}

function resolveBlock(toolPart: ToolPart): v3.ResolvedBlock | undefined {
    if (toolPart.state.status !== 'blocked') return undefined;
    const block = toolPart.state.block;
    if (block.type === 'permission') {
        return { ...block, decision: 'once' as const, decidedAt: Date.now() };
    }
    if (block.type === 'question') {
        return { ...block, answers: [], decidedAt: Date.now() };
    }
    return undefined;
}

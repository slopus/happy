import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import {
    createEnvelope,
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@slopus/happy-wire';
import {
    setActiveBashStreamCall,
    clearActiveBashStreamCall,
} from './bashStreamCallRegistry';
import { BASH_STREAM_AGENT_TOOL_NAME } from './startHappyServer';
import { recordToolUse, getToolNameById, shouldRedact } from '@/redact/redactGate';

export type ClaudeSessionProtocolState = {
    currentTurnId: string | null;
    /**
     * Set just before a turn that answers an external messenger request, and consumed by the
     * `turn-start` it stamps (Saycode specs/desktop-messenger-channels). Held separately from
     * `currentRequestId` so an id waiting for a turn that never opens cannot be inherited by a
     * later, unrelated one.
     */
    pendingRequestId?: string | null;
    /** The request the currently open turn answers; re-stamped on its `turn-end`. */
    currentRequestId?: string | null;
    /** Background task id/tool call id → the channel request that launched it. */
    backgroundTaskRequestIds?: Map<string, string>;
    uuidToProviderSubagent?: Map<string, string>;
    taskPromptToSubagents?: Map<string, string[]>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
    hiddenParentToolCalls?: Set<string>;
    /**
     * tool-call id → the turn and external request its `tool-call-start` was stamped with
     * (Saycode specs/desktop-messenger-channels — R9).
     *
     * Recorded because "which turn is current" is not the same question as "which turn contains
     * this tool call". The permission callback for a tool call is dispatched by the SDK on a
     * different path from the assistant message that carries the block
     * (`handleControlRequest` is not awaited and the message goes to a separate input stream), so
     * either can be observed first. Membership is the only order-independent answer.
     *
     * Entries live only as long as their turn: `closeTurn` drops them, so a tool-use id reused on
     * a later turn cannot be answered from the previous one.
     */
    toolCallTurns?: Map<string, { turnId: string; requestId: string | null }>;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
};

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

type ToolResultImage = { mediaType: string; data: string };

/**
 * Pull base64 image blocks out of a tool_result body (e.g. Read on a .png).
 * Mirrors the web's `extractToolResultImages` (parseAgentContent.ts) — kept
 * separate since the two sides don't share a package, but must stay in sync:
 * only base64-sourced image blocks survive, anything else (plain string
 * body, text blocks, url-sourced images) yields undefined.
 * specs/20260815-chat-tool-result-image-render.
 */
function extractToolResultImages(content: unknown): ToolResultImage[] | undefined {
    if (!Array.isArray(content)) return undefined;
    const images: ToolResultImage[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const { type, source } = block as { type?: string; source?: unknown };
        if (type !== 'image' || !source || typeof source !== 'object') continue;
        const { type: sourceType, media_type: mediaType, data } = source as {
            type?: string;
            media_type?: string;
            data?: string;
        };
        if (sourceType !== 'base64' || !mediaType || !data) continue;
        images.push({ mediaType, data });
    }
    return images.length > 0 ? images : undefined;
}

/**
 * Pull the background task id out of a launch's tool_result body.
 *
 * The launch tool call returns immediately with an id that identifies the
 * detached job; every later report about that job (a TaskStop, a
 * previous-session cleanup notice) names it by that id, never by the
 * tool_use id. Dropping it here leaves the web indicator unable to match a
 * stop to the launch it belongs to, so a stopped task shows as running
 * forever (specs/agent-activity-indicator Phase 22).
 *
 * Only the two harness-authored launch receipts are read. Anything else
 * yields undefined — this must never guess an id out of arbitrary output.
 */
function extractBackgroundTaskId(content: unknown): string | undefined {
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content
                .filter((block): block is { type: 'text'; text: string } => (
                    !!block && typeof block === 'object'
                    && (block as { type?: unknown }).type === 'text'
                    && typeof (block as { text?: unknown }).text === 'string'
                ))
                .map((block) => block.text)
                .join('\n')
            : null;
    if (!text) return undefined;
    const shell = text.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)/);
    if (shell) return shell[1];
    const agent = text.match(/^\s*agentId:\s*([A-Za-z0-9_-]+)/m);
    if (agent) return agent[1];
    return undefined;
}

function extractTaskNotificationIds(content: unknown): { taskId?: string; toolUseId?: string } {
    if (typeof content !== 'string') return {};
    const taskId = content.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/i)?.[1];
    const toolUseId = content.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/i)?.[1];
    return {
        ...(taskId ? { taskId } : {}),
        ...(toolUseId ? { toolUseId } : {}),
    };
}

function rememberBackgroundTaskRequest(state: ClaudeSessionProtocolState, id: string, requestId: string): void {
    const entries = state.backgroundTaskRequestIds ?? new Map<string, string>();
    state.backgroundTaskRequestIds = entries;
    entries.set(id, requestId);
    while (entries.size > 200) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
    }
}

/**
 * A background task launched while answering a channel request has reported back. Claude Code
 * answers it with a turn of its own once idle, so that turn answers the same request. Re-arm only
 * the request whose own launch produced this task; an unknown notification stays an in-app event.
 */
function rearmBackgroundTaskRequest(state: ClaudeSessionProtocolState, ids: { taskId?: string; toolUseId?: string }): void {
    const requests = state.backgroundTaskRequestIds;
    const requestId = (ids.taskId ? requests?.get(ids.taskId) : undefined)
        ?? (ids.toolUseId ? requests?.get(ids.toolUseId) : undefined);
    if (!requestId) return;
    if (!state.currentTurnId && !state.pendingRequestId) state.pendingRequestId = requestId;
    if (ids.taskId) requests?.delete(ids.taskId);
    if (ids.toolUseId) requests?.delete(ids.toolUseId);
}

function isSubagentTool(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

function shouldHideParentToolCall(name: string): boolean {
    return name === 'Task';
}

function pickProviderSubagent(message: RawJSONLines): string | undefined {
    const raw = message as { parent_tool_use_id?: unknown; parentToolUseId?: unknown };
    if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0) {
        return raw.parent_tool_use_id;
    }
    if (typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0) {
        return raw.parentToolUseId;
    }
    return undefined;
}

/**
 * A cap for one turn's tool calls, not a history. Entries are dropped when their turn closes, so
 * this only bounds a single pathological turn.
 */
const TOOL_CALL_TURN_MEMORY = 200;

function rememberToolCallTurn(
    state: ClaudeSessionProtocolState,
    call: string,
    turnId: string | undefined,
): void {
    if (!call || !turnId) return;
    const turns = state.toolCallTurns ?? new Map<string, { turnId: string; requestId: string | null }>();
    state.toolCallTurns = turns;
    turns.set(call, { turnId, requestId: state.currentRequestId ?? null });
    while (turns.size > TOOL_CALL_TURN_MEMORY) {
        const oldest = turns.keys().next();
        if (oldest.done) break;
        turns.delete(oldest.value);
    }
}

/** Every entry for a turn that has ended. Kept, they would answer for a later reused tool id. */
function forgetToolCallTurns(state: ClaudeSessionProtocolState, turnId: string): void {
    const turns = state.toolCallTurns;
    if (!turns) return;
    for (const [call, membership] of turns) {
        if (membership.turnId === turnId) turns.delete(call);
    }
}

/**
 * The turn a tool call belongs to, **while that turn is still open**, or null.
 *
 * Both halves matter. Membership alone is not enough: a tool-use id can repeat on a later turn,
 * and a retained entry would hand the new prompt the old turn and the old external request —
 * `instanceSeq` does not catch that, because the *new* instance would be binding to stale
 * membership rather than a stale item rebinding. And the current turn alone is never used: a
 * closed entry returns null so the caller waits for the tool call's own fresh `tool-call-start`,
 * rather than inheriting whatever is open now.
 */
export function toolCallTurnFor(
    state: ClaudeSessionProtocolState,
    call: string,
): { turnId: string; requestId: string | null } | null {
    const membership = state.toolCallTurns?.get(call);
    if (!membership) return null;
    if (state.currentTurnId !== membership.turnId) return null;
    return membership;
}

function getUuidToProviderSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.uuidToProviderSubagent) {
        state.uuidToProviderSubagent = new Map<string, string>();
    }
    return state.uuidToProviderSubagent;
}

function getTaskPromptToSubagents(state: ClaudeSessionProtocolState): Map<string, string[]> {
    if (!state.taskPromptToSubagents) {
        state.taskPromptToSubagents = new Map<string, string[]>();
    }
    return state.taskPromptToSubagents;
}

function getProviderSubagentToSessionSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.providerSubagentToSessionSubagent) {
        state.providerSubagentToSessionSubagent = new Map<string, string>();
    }
    return state.providerSubagentToSessionSubagent;
}

function getSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string | undefined {
    return getProviderSubagentToSessionSubagent(state).get(providerSubagent);
}

function ensureSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string {
    const existing = getSessionSubagentIdForProviderSubagent(state, providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    getProviderSubagentToSessionSubagent(state).set(providerSubagent, created);
    return created;
}

function getSubagentTitles(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.subagentTitles) {
        state.subagentTitles = new Map<string, string>();
    }
    return state.subagentTitles;
}

function getBufferedSubagentMessages(state: ClaudeSessionProtocolState): Map<string, RawJSONLines[]> {
    if (!state.bufferedSubagentMessages) {
        state.bufferedSubagentMessages = new Map<string, RawJSONLines[]>();
    }
    return state.bufferedSubagentMessages;
}

function getHiddenParentToolCalls(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.hiddenParentToolCalls) {
        state.hiddenParentToolCalls = new Set<string>();
    }
    return state.hiddenParentToolCalls;
}

function bufferSubagentMessage(state: ClaudeSessionProtocolState, subagent: string, message: RawJSONLines): void {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    queue.push(message);
    buffer.set(subagent, queue);
}

function consumeBufferedSubagentMessages(state: ClaudeSessionProtocolState, subagent: string): RawJSONLines[] {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    buffer.delete(subagent);
    return queue;
}

function getStartedSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.startedSubagents) {
        state.startedSubagents = new Set<string>();
    }
    return state.startedSubagents;
}

function getActiveSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.activeSubagents) {
        state.activeSubagents = new Set<string>();
    }
    return state.activeSubagents;
}

function pickUuid(message: RawJSONLines): string | undefined {
    const raw = message as { uuid?: unknown };
    if (typeof raw.uuid === 'string' && raw.uuid.length > 0) {
        return raw.uuid;
    }
    return undefined;
}

function pickParentUuid(message: RawJSONLines): string | undefined {
    const raw = message as { parentUuid?: unknown; parentUUID?: unknown };
    if (typeof raw.parentUuid === 'string' && raw.parentUuid.length > 0) {
        return raw.parentUuid;
    }
    if (typeof raw.parentUUID === 'string' && raw.parentUUID.length > 0) {
        return raw.parentUUID;
    }
    return undefined;
}

function isSidechainMessage(message: RawJSONLines): boolean {
    const raw = message as { isSidechain?: unknown };
    return raw.isSidechain === true;
}

function normalizePrompt(prompt: string): string {
    return prompt.trim();
}

function queueTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string, subagent: string): void {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized) ?? [];
    if (!queue.includes(subagent)) {
        queue.push(subagent);
    }
    promptMap.set(normalized, queue);
}

function consumeTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string): string | undefined {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return undefined;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    const subagent = queue.shift();
    if (queue.length === 0) {
        promptMap.delete(normalized);
    }
    return subagent;
}

function consumeSinglePendingTaskSubagent(state: ClaudeSessionProtocolState): string | undefined {
    const promptMap = getTaskPromptToSubagents(state);
    let candidateKey: string | null = null;
    let candidateSubagent: string | null = null;

    for (const [prompt, queue] of promptMap.entries()) {
        if (queue.length === 0) {
            continue;
        }

        if (candidateKey !== null) {
            return undefined;
        }

        candidateKey = prompt;
        candidateSubagent = queue[0] ?? null;
    }

    if (!candidateKey || !candidateSubagent) {
        return undefined;
    }

    const queue = promptMap.get(candidateKey);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    queue.shift();
    if (queue.length === 0) {
        promptMap.delete(candidateKey);
    }

    return candidateSubagent;
}

function pickSidechainRootPrompt(message: RawJSONLines): string | undefined {
    if (message.type !== 'user') {
        return undefined;
    }

    if (typeof message.message?.content === 'string') {
        const normalized = normalizePrompt(message.message.content);
        return normalized.length > 0 ? normalized : undefined;
    }

    return undefined;
}

function resolveProviderSubagent(message: RawJSONLines, state: ClaudeSessionProtocolState): string | undefined {
    const explicitSubagent = pickProviderSubagent(message);
    if (explicitSubagent) {
        return explicitSubagent;
    }

    const parentUuid = pickParentUuid(message);
    if (parentUuid) {
        const inheritedSubagent = getUuidToProviderSubagent(state).get(parentUuid);
        if (inheritedSubagent) {
            return inheritedSubagent;
        }
    }

    if (!isSidechainMessage(message)) {
        return undefined;
    }

    const prompt = pickSidechainRootPrompt(message);
    if (prompt) {
        const matchedSubagent = consumeTaskPromptSubagent(state, prompt);
        if (matchedSubagent) {
            return matchedSubagent;
        }
    }

    if (!parentUuid) {
        return consumeSinglePendingTaskSubagent(state);
    }

    return undefined;
}

function rememberSubagentForMessage(message: RawJSONLines, state: ClaudeSessionProtocolState, providerSubagent: string | undefined): void {
    if (!providerSubagent) {
        return;
    }

    const uuid = pickUuid(message);
    if (!uuid) {
        return;
    }

    getUuidToProviderSubagent(state).set(uuid, providerSubagent);
}

function pickTaskPrompt(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const prompt = (input as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string') {
        return undefined;
    }

    const normalized = normalizePrompt(prompt);
    return normalized.length > 0 ? normalized : undefined;
}

function pickTaskTitle(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const candidateKeys = ['description', 'title', 'subagent_type'];
    for (const key of candidateKeys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return undefined;
}

function setSubagentTitle(state: ClaudeSessionProtocolState, subagent: string, title: string | undefined): void {
    if (!title || title.trim().length === 0) {
        return;
    }
    getSubagentTitles(state).set(subagent, title.trim());
}

function maybeEmitSubagentStart(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string | undefined,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent) {
        return;
    }

    const started = getStartedSubagents(state);
    if (started.has(subagent)) {
        return;
    }

    const title = getSubagentTitles(state).get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
    }, { turn, subagent }));
    started.add(subagent);
    getActiveSubagents(state).add(subagent);
}

function maybeEmitSubagentStop(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string,
    envelopes: SessionEnvelope[],
): void {
    const active = getActiveSubagents(state);
    if (!active.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { turn, subagent }));
    active.delete(subagent);
}

function clearSubagentTracking(state: ClaudeSessionProtocolState): void {
    getUuidToProviderSubagent(state).clear();
    getTaskPromptToSubagents(state).clear();
    getProviderSubagentToSessionSubagent(state).clear();
    getSubagentTitles(state).clear();
    getBufferedSubagentMessages(state).clear();
    getHiddenParentToolCalls(state).clear();
    getStartedSubagents(state).clear();
    getActiveSubagents(state).clear();
}

function ensureTurn(state: ClaudeSessionProtocolState, envelopes: SessionEnvelope[]): string {
    if (state.currentTurnId) {
        return state.currentTurnId;
    }

    const turnId = createId();
    // Stamped on the boundary the request is actually answered by. The id is consumed here and
    // held for the matching `turn-end`, so a later unrelated turn cannot inherit it.
    const requestId = state.pendingRequestId ?? undefined;
    envelopes.push(createEnvelope('agent', { t: 'turn-start', ...(requestId ? { requestId } : {}) }, { turn: turnId }));
    state.currentTurnId = turnId;
    state.currentRequestId = requestId ?? null;
    state.pendingRequestId = null;
    return turnId;
}

function closeTurn(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    envelopes: SessionEnvelope[],
): void {
    if (!state.currentTurnId) {
        // A turn only opens on mapped activity, so a run that produced no assistant text — an
        // immediate failure, an empty completion — reaches its terminal result with nothing open.
        // A channel request waiting on that run must still get a correlated answer: without this
        // the id is stranded, the caller never learns the outcome, and the id would be inherited
        // by whatever turn opens next.
        if (!state.pendingRequestId) return;
        ensureTurn(state, envelopes);
    }
    const turnId = state.currentTurnId;
    if (!turnId) return;

    const requestId = state.currentRequestId ?? undefined;
    envelopes.push(createEnvelope(
        'agent',
        { t: 'turn-end', status, ...(requestId ? { requestId } : {}) },
        { turn: turnId },
    ));
    forgetToolCallTurns(state, turnId);
    state.currentTurnId = null;
    state.currentRequestId = null;
    clearSubagentTracking(state);
}

function toolTitle(name: string, input: unknown): string {
    if (input && typeof input === 'object') {
        const description = (input as { description?: unknown }).description;
        if (typeof description === 'string' && description.trim().length > 0) {
            return description.length > 80 ? `${description.slice(0, 77)}...` : description;
        }
    }
    return `${name} call`;
}

function toToolArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as Record<string, unknown>;
    }
    if (input === undefined) {
        return {};
    }
    return { input };
}

/** An authoritative result may be the first activity of a channel turn. */
export function mapClaudeChannelFinalAnswer(
    state: ClaudeSessionProtocolState,
    text: string,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    const requestId = state.currentTurnId ? state.currentRequestId : state.pendingRequestId;
    if (requestId && typeof text === 'string' && text.trim().length > 0) {
        const turn = ensureTurn(state, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'final-answer', text, requestId }, { turn }));
    }
    return { currentTurnId: state.currentTurnId, envelopes };
}

export function closeClaudeTurnWithStatus(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    closeTurn(state, status, envelopes);
    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}

export function mapClaudeLogMessageToSessionEnvelopes(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    return mapClaudeLogMessageToSessionEnvelopesInternal(message, state);
}

function mapClaudeLogMessageToSessionEnvelopesInternal(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    const claudeUuid = pickUuid(message);
    const providerSubagent = resolveProviderSubagent(message, state);
    const subagent = providerSubagent
        ? getSessionSubagentIdForProviderSubagent(state, providerSubagent)
        : undefined;
    rememberSubagentForMessage(message, state, providerSubagent);

    if (providerSubagent && !subagent) {
        bufferSubagentMessage(state, providerSubagent, message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [],
        };
    }

    if (message.type === 'summary') {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'system') {
        // The SDK's own report of a finished background task. It precedes the provider's
        // follow-up turn on the same ordered stream; the transcript row of an idle notification
        // reaches us only through the scanner, which can be late.
        const notification = message as { subtype?: unknown; task_id?: unknown; tool_use_id?: unknown };
        if (notification.subtype === 'task_notification') {
            rearmBackgroundTaskRequest(state, {
                ...(typeof notification.task_id === 'string' ? { taskId: notification.task_id } : {}),
                ...(typeof notification.tool_use_id === 'string' ? { toolUseId: notification.tool_use_id } : {}),
            });
        }
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if ((message as any).isCompactSummary) {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'assistant') {
        const turnId = ensureTurn(state, envelopes);
        maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];

        for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid }));
                continue;
            }

            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.thinking, thinking: true }, { turn: turnId, subagent, claudeUuid }));
                continue;
            }

            if (block.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId();
                const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
                // (id -> name) so the matching tool_result can apply the same
                // redact policy to its images that redactGate already applies
                // to text (specs/20260815-chat-tool-result-image-render).
                recordToolUse(call, name);
                const baseArgs = toToolArgs(block.input);
                const title = toolTitle(name, block.input);
                const sessionSubagentForCall = ensureSessionSubagentIdForProviderSubagent(state, call);
                if (isSubagentTool(name)) {
                    const prompt = pickTaskPrompt(block.input);
                    if (prompt) {
                        queueTaskPromptSubagent(state, prompt, call);
                    }
                    setSubagentTitle(state, sessionSubagentForCall, pickTaskTitle(block.input) ?? prompt);
                }
                if (shouldHideParentToolCall(name)) {
                    getHiddenParentToolCalls(state).add(call);

                    const buffered = consumeBufferedSubagentMessages(state, call);
                    for (const bufferedMessage of buffered) {
                        const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                        envelopes.push(...replay.envelopes);
                    }
                    continue;
                }
                const args = isSubagentTool(name)
                    ? { ...baseArgs, sessionSubagent: sessionSubagentForCall }
                    : baseArgs;

                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name,
                    title,
                    description: title,
                    args,
                }, { turn: turnId, subagent }));
                // chat-tool-output-streaming Phase 3 — track the live
                // call id so the in-process bash_stream MCP handler can
                // address its progress envelopes to it.
                rememberToolCallTurn(state, call, turnId);
                if (name === BASH_STREAM_AGENT_TOOL_NAME) {
                    setActiveBashStreamCall(call);
                }
                const buffered = consumeBufferedSubagentMessages(state, call);
                for (const bufferedMessage of buffered) {
                    const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                    envelopes.push(...replay.envelopes);
                }
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'user') {
        // SDK-injected synthetic user messages (e.g. the Skill tool feeds
        // the skill prompt back to Claude as a 'user' message with
        // isMeta=true so the model sees it but the human shouldn't).
        // Without this skip the prompt body — easily 10–20k characters —
        // gets emitted as an agent-text envelope and lands in the chat as
        // a wall of text.
        if (message.isMeta) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }
        if (typeof message.message.content === 'string') {
            // A task notification the session scanner promoted from a
            // mid-turn attachment row belongs to the turn that is still
            // running — closing it here would record a premature turn-end
            // (specs/midturn-task-notification-sync R2). Emit the user text
            // and leave the turn state untouched.
            if ((message as { happyTaskNotification?: unknown }).happyTaskNotification === true) {
                rearmBackgroundTaskRequest(state, extractTaskNotificationIds(message.message.content));
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }, { claudeUuid }));
                return {
                    currentTurnId: state.currentTurnId,
                    envelopes,
                };
            }
            if (message.isSidechain) {
                const turnId = ensureTurn(state, envelopes);
                maybeEmitSubagentStart(state, turnId, subagent, envelopes);
                envelopes.push(createEnvelope('agent', { t: 'text', text: message.message.content }, { turn: turnId, subagent, claudeUuid }));
            } else if ((message as { origin?: { kind?: unknown } }).origin?.kind === 'task-notification') {
                // A notification consumed while idle starts the provider's follow-up turn. Close
                // what is open as any user row does, but never open-and-close an empty turn for a
                // waiting request: that would answer it before the follow-up does.
                if (state.currentTurnId) closeTurn(state, 'completed', envelopes);
                rearmBackgroundTaskRequest(state, extractTaskNotificationIds(message.message.content));
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }, { claudeUuid }));
            } else {
                closeTurn(state, 'completed', envelopes);
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }, { claudeUuid }));
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        if (blocks.length === 0) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const hasToolResult = blocks.some((block) => {
            return block?.type === 'tool_result';
        });
        if (!message.isSidechain && !hasToolResult) {
            closeTurn(state, 'completed', envelopes);
            for (const block of blocks) {
                if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                    envelopes.push(createEnvelope('user', { t: 'text', text: block.text }, { claudeUuid }));
                }
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const turnId = ensureTurn(state, envelopes);
        if (message.isSidechain) {
            maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        }
        for (const block of blocks) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
                const sessionSubagentForToolResult = getSessionSubagentIdForProviderSubagent(state, block.tool_use_id);
                const redacted = shouldRedact(getToolNameById(block.tool_use_id));
                const backgroundTaskId = redacted
                    ? undefined
                    : extractBackgroundTaskId((block as { content?: unknown }).content);
                // Task parent calls are hidden from the transcript, but their result still carries
                // the launch id needed to correlate the later notification.
                if (backgroundTaskId && state.currentRequestId) {
                    rememberBackgroundTaskRequest(state, backgroundTaskId, state.currentRequestId);
                    rememberBackgroundTaskRequest(state, block.tool_use_id, state.currentRequestId);
                }
                if (!message.isSidechain) {
                    if (getHiddenParentToolCalls(state).has(block.tool_use_id)) {
                        if (sessionSubagentForToolResult) {
                            maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                        }
                        getHiddenParentToolCalls(state).delete(block.tool_use_id);
                        continue;
                    }
                    if (sessionSubagentForToolResult) {
                        maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                    }
                }
                const images = redacted
                    ? undefined
                    : extractToolResultImages((block as { content?: unknown }).content);
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                    ...(images ? { images } : {}),
                    ...(backgroundTaskId ? { backgroundTaskId } : {}),
                }, { turn: turnId, subagent }));
                clearActiveBashStreamCall(block.tool_use_id);
                continue;
            }

            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid }));
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}

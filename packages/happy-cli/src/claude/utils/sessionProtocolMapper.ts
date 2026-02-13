import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import {
    createEnvelope,
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@slopus/happy-wire';

export type ClaudeSessionProtocolState = {
    currentTurnId: string | null;
    uuidToProviderSubagent?: Map<string, string>;
    taskPromptToSubagents?: Map<string, string[]>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
    hiddenParentToolCalls?: Set<string>;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
};

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

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
    envelopes.push(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
    state.currentTurnId = turnId;
    return turnId;
}

function closeTurn(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    envelopes: SessionEnvelope[],
): void {
    if (!state.currentTurnId) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'turn-end', status }, { turn: state.currentTurnId }));
    state.currentTurnId = null;
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
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent }));
                continue;
            }

            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.thinking, thinking: true }, { turn: turnId, subagent }));
                continue;
            }

            if (block.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId();
                const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
                const args = toToolArgs(block.input);
                const title = toolTitle(name, block.input);
                const sessionSubagentForCall = ensureSessionSubagentIdForProviderSubagent(state, call);
                if (name === 'Task') {
                    const prompt = pickTaskPrompt(block.input);
                    if (prompt) {
                        queueTaskPromptSubagent(state, prompt, call);
                    }
                    setSubagentTitle(state, sessionSubagentForCall, pickTaskTitle(block.input) ?? prompt);
                    getHiddenParentToolCalls(state).add(call);

                    const buffered = consumeBufferedSubagentMessages(state, call);
                    for (const bufferedMessage of buffered) {
                        const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                        envelopes.push(...replay.envelopes);
                    }
                    continue;
                }

                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name,
                    title,
                    description: title,
                    args,
                }, { turn: turnId, subagent }));
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
        if (typeof message.message.content === 'string') {
            if (message.isSidechain) {
                const turnId = ensureTurn(state, envelopes);
                maybeEmitSubagentStart(state, turnId, subagent, envelopes);
                envelopes.push(createEnvelope('agent', { t: 'text', text: message.message.content }, { turn: turnId, subagent }));
            } else {
                closeTurn(state, 'completed', envelopes);
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }));
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

        const turnId = ensureTurn(state, envelopes);
        if (message.isSidechain) {
            maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        }
        for (const block of blocks) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
                const sessionSubagentForToolResult = getSessionSubagentIdForProviderSubagent(state, block.tool_use_id);
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
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                }, { turn: turnId, subagent }));
                continue;
            }

            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent }));
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

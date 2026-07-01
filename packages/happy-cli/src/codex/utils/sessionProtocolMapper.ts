import { createHash, randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope, type SessionUsage } from '@slopus/happy-wire';
import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';

export type CodexTurnState = {
    currentTurnId: string | null;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    collabReceiverThreadIdsByCall?: Map<string, string[]>;
    collabToolByCall?: Map<string, string>;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    startedSubagents: Set<string>;
    activeSubagents: Set<string>;
    providerSubagentToSessionSubagent: Map<string, string>;
    subagentTitles: Map<string, string>;
    collabReceiverThreadIdsByCall: Map<string, string[]>;
    collabToolByCall: Map<string, string>;
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

type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

function getStartedSubagents(state: CodexTurnState): Set<string> {
    return state.startedSubagents ?? new Set<string>();
}

function getActiveSubagents(state: CodexTurnState): Set<string> {
    return state.activeSubagents ?? new Set<string>();
}

function getProviderSubagentToSessionSubagent(state: CodexTurnState): Map<string, string> {
    return state.providerSubagentToSessionSubagent ?? new Map<string, string>();
}

function getSubagentTitles(state: CodexTurnState): Map<string, string> {
    return state.subagentTitles ?? new Map<string, string>();
}

function getCollabReceiverThreadIdsByCall(state: CodexTurnState): Map<string, string[]> {
    return state.collabReceiverThreadIdsByCall ?? new Map<string, string[]>();
}

function getCollabToolByCall(state: CodexTurnState): Map<string, string> {
    return state.collabToolByCall ?? new Map<string, string>();
}

function deterministicSessionSubagentId(providerSubagent: string): string {
    const digest = createHash('sha256')
        .update(`codex-subagent:${providerSubagent}`)
        .digest('hex');
    return `c${digest.slice(0, 23)}`;
}

function ensureSessionSubagent(
    providerSubagent: string,
    providerSubagentToSessionSubagent: Map<string, string>,
): string {
    const existing = providerSubagentToSessionSubagent.get(providerSubagent);
    if (existing) {
        return existing;
    }

    const created = deterministicSessionSubagentId(providerSubagent);
    providerSubagentToSessionSubagent.set(providerSubagent, created);
    return created;
}

function maybeEmitSubagentStart(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    subagentTitles: Map<string, string>,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent || startedSubagents.has(subagent)) {
        return;
    }

    const title = subagentTitles.get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
    }, { ...opts, subagent }));
    startedSubagents.add(subagent);
    activeSubagents.add(subagent);
}

function maybeEmitSubagentStop(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    activeSubagents: Set<string>,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent || !activeSubagents.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    activeSubagents.delete(subagent);
}

function emitSubagentStops(
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    for (const subagent of activeSubagents) {
        envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    }
    activeSubagents.clear();
    startedSubagents.clear();
    return envelopes;
}

function buildEnvelopeOptions(currentTurnId: string | null, subagent?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(subagent ? { subagent } : {}),
    };
}

function pickTokenCount(message: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = message[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return Math.trunc(value);
        }
    }
    return undefined;
}

function pickTokenUsageSource(message: Record<string, unknown>): Record<string, unknown> {
    if (message.last && typeof message.last === 'object' && !Array.isArray(message.last)) {
        return message.last as Record<string, unknown>;
    }
    return message.total && typeof message.total === 'object' && !Array.isArray(message.total)
        ? message.total as Record<string, unknown>
        : message;
}

function pickTokenUsage(message: Record<string, unknown>): SessionUsage | undefined {
    const source = pickTokenUsageSource(message);
    const input = pickTokenCount(source, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']);
    const output = pickTokenCount(source, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']);
    const cacheCreation = pickTokenCount(source, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens',
        'cacheCreation',
        'cache_write_input_tokens',
        'cacheWriteInputTokens',
    ]);
    const cacheRead = pickTokenCount(source, [
        'cache_read_input_tokens',
        'cacheReadInputTokens',
        'cacheRead',
        'cached_input_tokens',
        'cachedInputTokens',
    ]);
    const total = pickTokenCount(source, ['total_tokens', 'totalTokens', 'tokensUsed', 'usedTokens']);
    const contextWindow = pickTokenCount(message, [
        'context_window',
        'contextWindow',
        'model_context_window',
        'modelContextWindow',
    ]);

    if (
        input === undefined
        && output === undefined
        && cacheCreation === undefined
        && cacheRead === undefined
        && total === undefined
    ) {
        return undefined;
    }

    const outputTokens = output ?? 0;
    const cacheCreationTokens = cacheCreation ?? 0;
    const cacheReadTokens = cacheRead ?? 0;
    const inputTokensIncludeCache = input !== undefined
        && total !== undefined
        && total === input + outputTokens;
    const fallbackInputTokens = input
        ?? Math.max(0, (total ?? 0) - outputTokens - cacheCreationTokens - cacheReadTokens);
    const inputTokens = inputTokensIncludeCache && input !== undefined
        ? Math.max(0, input - cacheCreationTokens - cacheReadTokens)
        : fallbackInputTokens;
    const serviceTier = typeof message.service_tier === 'string'
        ? message.service_tier
        : (typeof message.serviceTier === 'string' ? message.serviceTier : undefined);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
        ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(serviceTier ? { service_tier: serviceTier } : {}),
    };
}

function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [
        message.subagent,
        message.parent_call_id,
        message.parentCallId,
        message.agent_thread_id,
        message.agentThreadId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}

function resolveSessionSubagent(
    message: Record<string, unknown>,
    providerSubagentToSessionSubagent: Map<string, string>,
): string | undefined {
    const providerSubagent = pickProviderSubagent(message);
    if (!providerSubagent) {
        return undefined;
    }

    return ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
}

function pickCallId(message: Record<string, unknown>): string {
    const callId = message.call_id ?? message.callId;
    if (typeof callId === 'string' && callId.length > 0) {
        return callId;
    }
    return randomUUID();
}

function pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}

function pickStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function shortText(value: string, max = 80): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function collabToolTitle(tool: string | undefined, prompt: string | undefined): string {
    if (prompt) {
        return shortText(prompt);
    }

    switch (tool) {
        case 'spawnAgent':
            return 'Spawn Codex subagent';
        case 'sendInput':
            return 'Send input to Codex subagent';
        case 'resumeAgent':
            return 'Resume Codex subagent';
        case 'wait':
            return 'Wait for Codex subagent';
        case 'closeAgent':
            return 'Close Codex subagent';
        default:
            return 'Codex subagent';
    }
}

function collabToolDescription(tool: string | undefined, prompt: string | undefined): string {
    const title = collabToolTitle(tool, prompt);
    if (!prompt) {
        return title;
    }
    switch (tool) {
        case 'spawnAgent':
            return `Spawn Codex subagent: ${shortText(prompt, 120)}`;
        case 'sendInput':
            return `Send input to Codex subagent: ${shortText(prompt, 120)}`;
        default:
            return title;
    }
}

function pickCollabReceiverThreadIds(message: Record<string, unknown>): string[] {
    return pickStringArray(message.receiver_thread_ids ?? message.receiverThreadIds);
}

function pickCollabAgentStateThreadIds(message: Record<string, unknown>): string[] {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [];
    }
    return Object.keys(raw).filter((key) => key.length > 0);
}

function resolveCollabProviderIds(
    call: string,
    message: Record<string, unknown>,
    collabReceiverThreadIdsByCall: Map<string, string[]>,
): string[] {
    const receiverThreadIds = pickCollabReceiverThreadIds(message);
    if (receiverThreadIds.length > 0) {
        collabReceiverThreadIdsByCall.set(call, receiverThreadIds);
        return receiverThreadIds;
    }

    const remembered = collabReceiverThreadIdsByCall.get(call);
    if (remembered && remembered.length > 0) {
        return remembered;
    }

    const stateThreadIds = pickCollabAgentStateThreadIds(message);
    if (stateThreadIds.length > 0) {
        collabReceiverThreadIdsByCall.set(call, stateThreadIds);
        return stateThreadIds;
    }

    return [call];
}

function resolveCollabTool(
    call: string,
    message: Record<string, unknown>,
    collabToolByCall: Map<string, string>,
): string | undefined {
    const tool = pickString(message.tool);
    if (tool) {
        collabToolByCall.set(call, tool);
        return tool;
    }
    return collabToolByCall.get(call);
}

function isCollabCallInProgress(message: Record<string, unknown>): boolean {
    const status = pickString(message.status);
    return status === 'inProgress';
}

function collabAgentStates(
    message: Record<string, unknown>,
    sessionSubagentsByProviderId: Record<string, string>,
): Array<{ sessionSubagent: string; status?: string; message?: string | null }> {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return [];
    }

    const states: Array<{ sessionSubagent: string; status?: string; message?: string | null }> = [];
    for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
        const sessionSubagent = sessionSubagentsByProviderId[providerId];
        if (!sessionSubagent || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        const record = state as Record<string, unknown>;
        states.push({
            sessionSubagent,
            ...(typeof record.status === 'string' ? { status: record.status } : {}),
            ...(typeof record.message === 'string' || record.message === null ? { message: record.message } : {}),
        });
    }
    return states;
}

function emitCollabAgentStateMessages(
    envelopes: SessionEnvelope[],
    message: Record<string, unknown>,
    sessionSubagentsByProviderId: Record<string, string>,
    opts: CreateEnvelopeOptions,
): void {
    const raw = message.agents_states ?? message.agentsStates;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return;
    }

    for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
        const sessionSubagent = sessionSubagentsByProviderId[providerId];
        if (!sessionSubagent || !state || typeof state !== 'object' || Array.isArray(state)) {
            continue;
        }
        const status = pickString((state as Record<string, unknown>).status);
        const statusMessage = pickString((state as Record<string, unknown>).message);
        if (!statusMessage) {
            continue;
        }
        const prefix = status ? `Codex subagent ${status}` : 'Codex subagent';
        envelopes.push(createEnvelope('agent', {
            t: 'service',
            text: `${prefix}: ${statusMessage}`,
        }, { ...opts, subagent: sessionSubagent }));
    }
}

function subagentActivityServiceText(kind: unknown, agentPath: string | undefined): string | undefined {
    if (kind === 'started') {
        return agentPath ? `Codex subagent started: ${agentPath}` : 'Codex subagent started';
    }
    if (kind === 'interrupted') {
        return 'Codex subagent interrupted';
    }
    return undefined;
}

function maybeEmitSubagentActivityService(
    envelopes: SessionEnvelope[],
    kind: unknown,
    agentPath: string | undefined,
    opts: CreateEnvelopeOptions,
    sessionSubagent: string,
): void {
    const text = subagentActivityServiceText(kind, agentPath);
    if (!text) {
        return;
    }
    envelopes.push(createEnvelope('agent', { t: 'service', text }, { ...opts, subagent: sessionSubagent }));
}

function registerCodexSubagents(
    providerIds: string[],
    title: string | undefined,
    providerSubagentToSessionSubagent: Map<string, string>,
    subagentTitles: Map<string, string>,
): { primarySubagent?: string; sessionSubagents: Record<string, string> } {
    const sessionSubagents: Record<string, string> = {};
    let primarySubagent: string | undefined;

    for (const providerId of providerIds) {
        const sessionSubagent = ensureSessionSubagent(providerId, providerSubagentToSessionSubagent);
        sessionSubagents[providerId] = sessionSubagent;
        if (!primarySubagent) {
            primarySubagent = sessionSubagent;
        }
        if (title) {
            subagentTitles.set(sessionSubagent, title);
        }
    }

    return { primarySubagent, sessionSubagents };
}

function collabArgs(
    message: Record<string, unknown>,
    primarySubagent: string | undefined,
    sessionSubagents: Record<string, string>,
): Record<string, unknown> {
    const sessionSubagentValues = Object.values(sessionSubagents);
    return {
        tool: pickString(message.tool) ?? 'unknown',
        status: pickString(message.status) ?? 'unknown',
        prompt: pickString(message.prompt) ?? null,
        model: pickString(message.model) ?? null,
        reasoningEffort: pickString(message.reasoning_effort ?? message.reasoningEffort) ?? null,
        agentStates: collabAgentStates(message, sessionSubagents),
        ...(primarySubagent ? { sessionSubagent: primarySubagent } : {}),
        ...(sessionSubagentValues.length > 0 ? { sessionSubagents: sessionSubagentValues } : {}),
    };
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

export function turnTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

export function completedTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.completedAt ?? turn.startedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function textFromInputItems(items: unknown): string | null {
    if (!Array.isArray(items)) {
        return null;
    }
    const text = items
        .filter((item): item is { type: 'text'; text: string } => (
            Boolean(item)
            && typeof item === 'object'
            && (item as { type?: unknown }).type === 'text'
            && typeof (item as { text?: unknown }).text === 'string'
        ))
        .map((item) => item.text)
        .join('\n')
        .trim();
    return text.length > 0 ? text : null;
}

function reasoningText(item: ThreadItem): string | null {
    const summary = (item as { summary?: unknown }).summary;
    const content = (item as { content?: unknown }).content;
    const parts = [
        ...(Array.isArray(summary) ? summary : []),
        ...(Array.isArray(content) ? content : []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const text = parts.join('\n').trim();
    return text.length > 0 ? text : null;
}

export function turnStatus(turn: ThreadTurn): TurnEndStatus {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
}

export function isCodexTurnInProgress(turn: ThreadTurn): boolean {
    const status = typeof turn.status === 'string' ? turn.status : null;
    return status === 'inProgress' || status === 'running' || status === 'active' || status === 'pending';
}

function emitHistoricalToolCall(
    envelopes: SessionEnvelope[],
    turn: ThreadTurn,
    item: ThreadItem,
    name: string,
    title: string,
    args: Record<string, unknown>,
    output: string | null,
    timestamps?: {
        startedAt: number;
        completedAt: number;
    },
): void {
    const time = timestamps?.startedAt ?? turnTimestampMs(turn);
    const opts = { turn: turn.id, time, codexItemId: item.id } satisfies CreateEnvelopeOptions;
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-start',
        call: item.id,
        name,
        title,
        description: title,
        args,
    }, {
        ...opts,
        id: `${item.id}:start`,
    }));

    if (output && output.trim().length > 0) {
        envelopes.push(createEnvelope('agent', {
            t: 'text',
            text: output,
            thinking: true,
        }, {
            ...opts,
            id: `${item.id}:output`,
        }));
    }

    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-end',
        call: item.id,
    }, {
        ...opts,
        id: `${item.id}:end`,
        time: timestamps?.completedAt ?? completedTimestampMs(turn),
    }));
}

export function mapCodexThreadItemToSessionEnvelopes(
    turn: ThreadTurn,
    item: ThreadItem,
    timestamps?: {
        startedAt: number;
        completedAt: number;
    },
    state?: CodexTurnState,
): SessionEnvelope[] {
    const startedAt = timestamps?.startedAt ?? turnTimestampMs(turn);
    const completedAt = timestamps?.completedAt ?? completedTimestampMs(turn);
    const mappingState = state ?? { currentTurnId: turn.id };
    const startedSubagents = getStartedSubagents(mappingState);
    const activeSubagents = getActiveSubagents(mappingState);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(mappingState);
    const subagentTitles = getSubagentTitles(mappingState);
    const collabReceiverThreadIdsByCall = getCollabReceiverThreadIdsByCall(mappingState);
    const collabToolByCall = getCollabToolByCall(mappingState);

    switch (item.type) {
        case 'userMessage': {
            const text = textFromInputItems(item.content);
            return text
                ? [createEnvelope('user', { t: 'text', text }, {
                    id: item.id,
                    time: startedAt,
                    codexItemId: item.id,
                })]
                : [];
        }
        case 'agentMessage': {
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            if (text.length === 0) {
                return [];
            }

            const subagent = resolveSessionSubagent(item as Record<string, unknown>, providerSubagentToSessionSubagent);
            const opts = {
                id: item.id,
                turn: turn.id,
                time: completedAt,
                codexItemId: item.id,
                ...(subagent ? { subagent } : {}),
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
            envelopes.push(createEnvelope('agent', { t: 'text', text }, opts));
            return envelopes;
        }
        case 'reasoning': {
            const text = reasoningText(item);
            if (!text) {
                return [];
            }

            const subagent = resolveSessionSubagent(item as Record<string, unknown>, providerSubagentToSessionSubagent);
            const opts = {
                id: item.id,
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
                ...(subagent ? { subagent } : {}),
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
            envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
            return envelopes;
        }
        case 'commandExecution': {
            const envelopes: SessionEnvelope[] = [];
            const command = typeof item.command === 'string' ? item.command : '';
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexBash',
                commandToTitle(command),
                { command, cwd: item.cwd },
                typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'fileChange': {
            const envelopes: SessionEnvelope[] = [];
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexPatch',
                'Apply patch',
                { changes: item.changes, status: item.status },
                null,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'mcpToolCall': {
            const envelopes: SessionEnvelope[] = [];
            const title = `${item.server}.${item.tool}`;
            const output = item.error !== undefined && item.error !== null
                ? String(item.error)
                : (item.result !== undefined && item.result !== null ? String(item.result) : null);
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'McpTool',
                title,
                {
                    server: item.server,
                    tool: item.tool,
                    arguments: item.arguments,
                },
                output,
                { startedAt, completedAt },
            );
            return envelopes;
        }
        case 'collabAgentToolCall': {
            const itemRecord = item as Record<string, unknown>;
            const tool = resolveCollabTool(item.id, itemRecord, collabToolByCall);
            const prompt = pickString(itemRecord.prompt);
            const title = collabToolTitle(tool, prompt);
            const providerIds = resolveCollabProviderIds(item.id, itemRecord, collabReceiverThreadIdsByCall);
            const { primarySubagent, sessionSubagents } = registerCodexSubagents(
                providerIds,
                title,
                providerSubagentToSessionSubagent,
                subagentTitles,
            );
            const startOpts = {
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const endOpts = {
                turn: turn.id,
                time: completedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [
                createEnvelope('agent', {
                    t: 'tool-call-start',
                    call: item.id,
                    name: 'CodexSubagent',
                    title,
                    description: collabToolDescription(tool, prompt),
                    args: collabArgs(itemRecord, primarySubagent, sessionSubagents),
                }, {
                    ...startOpts,
                    id: `${item.id}:start`,
                }),
            ];

            for (const sessionSubagent of Object.values(sessionSubagents)) {
                maybeEmitSubagentStart(
                    sessionSubagent,
                    startOpts,
                    startedSubagents,
                    activeSubagents,
                    subagentTitles,
                    envelopes,
                );
            }

            if (!isCollabCallInProgress(itemRecord)) {
                emitCollabAgentStateMessages(envelopes, itemRecord, sessionSubagents, endOpts);
                envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call: item.id }, {
                    ...endOpts,
                    id: `${item.id}:end`,
                }));
                if (tool === 'closeAgent') {
                    for (const sessionSubagent of Object.values(sessionSubagents)) {
                        maybeEmitSubagentStop(sessionSubagent, endOpts, activeSubagents, envelopes);
                    }
                }
                collabReceiverThreadIdsByCall.delete(item.id);
                collabToolByCall.delete(item.id);
            }
            return envelopes;
        }
        case 'subAgentActivity': {
            const itemRecord = item as Record<string, unknown>;
            const providerSubagent = pickString(itemRecord.agentThreadId ?? itemRecord.agent_thread_id);
            if (!providerSubagent) {
                return [];
            }
            const sessionSubagent = ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
            const agentPath = pickString(itemRecord.agentPath ?? itemRecord.agent_path);
            if (agentPath) {
                subagentTitles.set(sessionSubagent, agentPath);
            }
            const opts = {
                turn: turn.id,
                time: startedAt,
                codexItemId: item.id,
            } satisfies CreateEnvelopeOptions;
            const envelopes: SessionEnvelope[] = [];
            maybeEmitSubagentStart(
                sessionSubagent,
                opts,
                startedSubagents,
                activeSubagents,
                subagentTitles,
                envelopes,
            );
            maybeEmitSubagentActivityService(envelopes, itemRecord.kind, agentPath, opts, sessionSubagent);
            if (itemRecord.kind === 'interrupted') {
                maybeEmitSubagentStop(sessionSubagent, opts, activeSubagents, envelopes);
            }
            return envelopes;
        }
        default:
            return [];
    }
}

export function mapCodexThreadToSessionEnvelopes(thread: Pick<Thread, 'turns'>): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    const providerSubagentToSessionSubagent = new Map<string, string>();
    const subagentTitles = new Map<string, string>();
    const collabReceiverThreadIdsByCall = new Map<string, string[]>();
    const collabToolByCall = new Map<string, string>();

    for (const turn of thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        const state: CodexTurnState = {
            currentTurnId: turn.id,
            startedSubagents: new Set<string>(),
            activeSubagents: new Set<string>(),
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
        };
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        const timestamps = { startedAt, completedAt };
        for (const item of turn.items ?? []) {
            envelopes.push(...mapCodexThreadItemToSessionEnvelopes(turn, item, timestamps, state));
        }

        if (!isCodexTurnInProgress(turn)) {
            envelopes.push(...emitSubagentStops(
                { turn: turn.id, time: completedAt },
                getStartedSubagents(state),
                getActiveSubagents(state),
            ));
            envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
                id: `${turn.id}:end`,
                turn: turn.id,
                time: completedAt,
            }));
        }
    }

    return envelopes;
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

function pickTurnEndStatus(message: Record<string, unknown>, type: unknown): TurnEndStatus {
    const rawStatus = message.status;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled') {
        return rawStatus;
    }
    if (rawStatus === 'canceled') {
        return 'cancelled';
    }

    // Abort events are treated as cancelled unless they explicitly look like failures.
    if (type === 'turn_aborted') {
        const reason = message.reason;
        const error = message.error;
        if ((typeof reason === 'string' && /(fail|error)/i.test(reason))
            || (typeof error === 'string' && error.length > 0)
            || (error !== undefined && error !== null && typeof error === 'object')) {
            return 'failed';
        }
        return 'cancelled';
    }

    if (message.error !== undefined && message.error !== null) {
        return 'failed';
    }

    return 'completed';
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);
    const subagentTitles = getSubagentTitles(state);
    const collabReceiverThreadIdsByCall = getCollabReceiverThreadIdsByCall(state);
    const collabToolByCall = getCollabToolByCall(state);

    if (type === 'task_started') {
        const turnId = createId();
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
        startedSubagents.clear();
        activeSubagents.clear();
        collabReceiverThreadIdsByCall.clear();
        collabToolByCall.clear();
        return {
            currentTurnId: turnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
        collabReceiverThreadIdsByCall.clear();
        collabToolByCall.clear();
        return {
            currentTurnId: null,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: [
                ...emitSubagentStops(lifecycleOpts, startedSubagents, activeSubagents),
                createEnvelope('agent', {
                    t: 'turn-end',
                    status: pickTurnEndStatus(message, type),
                }, lifecycleOpts),
            ],
        };
    }

    if (type === 'token_count') {
        const usage = pickTokenUsage(message);
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes: usage
                ? [createEnvelope('agent', { t: 'service', text: '' }, {
                    ...buildEnvelopeOptions(state.currentTurnId),
                    usage,
                })]
                : [],
        };
    }

    if (type === 'collab_agent_begin' || type === 'collab_agent_end') {
        const call = pickCallId(message);
        const tool = resolveCollabTool(call, message, collabToolByCall);
        const prompt = pickString(message.prompt);
        const title = collabToolTitle(tool, prompt);
        const providerIds = resolveCollabProviderIds(call, message, collabReceiverThreadIdsByCall);
        const { primarySubagent, sessionSubagents } = registerCodexSubagents(
            providerIds,
            title,
            providerSubagentToSessionSubagent,
            subagentTitles,
        );
        const turnOpts = buildEnvelopeOptions(state.currentTurnId);
        const envelopes: SessionEnvelope[] = [];

        if (type === 'collab_agent_begin') {
            envelopes.push(createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexSubagent',
                title,
                description: collabToolDescription(tool, prompt),
                args: collabArgs(message, primarySubagent, sessionSubagents),
            }, turnOpts));

            for (const sessionSubagent of Object.values(sessionSubagents)) {
                maybeEmitSubagentStart(
                    sessionSubagent,
                    turnOpts,
                    startedSubagents,
                    activeSubagents,
                    subagentTitles,
                    envelopes,
                );
            }
        } else {
            emitCollabAgentStateMessages(envelopes, message, sessionSubagents, turnOpts);
            envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, turnOpts));
            if (tool === 'closeAgent') {
                for (const sessionSubagent of Object.values(sessionSubagents)) {
                    maybeEmitSubagentStop(sessionSubagent, turnOpts, activeSubagents, envelopes);
                }
            }
            collabReceiverThreadIdsByCall.delete(call);
            collabToolByCall.delete(call);
        }

        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'subagent_activity') {
        const providerSubagent = pickString(message.agent_thread_id ?? message.agentThreadId);
        if (!providerSubagent) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const sessionSubagent = ensureSessionSubagent(providerSubagent, providerSubagentToSessionSubagent);
        const agentPath = pickString(message.agent_path ?? message.agentPath);
        if (agentPath) {
            subagentTitles.set(sessionSubagent, agentPath);
        }
        const turnOpts = buildEnvelopeOptions(state.currentTurnId);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(
            sessionSubagent,
            turnOpts,
            startedSubagents,
            activeSubagents,
            subagentTitles,
            envelopes,
        );
        maybeEmitSubagentActivityService(envelopes, message.kind, agentPath, turnOpts, sessionSubagent);
        if (message.kind === 'interrupted') {
            maybeEmitSubagentStop(sessionSubagent, turnOpts, activeSubagents, envelopes);
        }

        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
    const opts = buildEnvelopeOptions(state.currentTurnId, subagent);

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text: message.message }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
        const text = typeof message.text === 'string'
            ? message.text
            : (typeof message.delta === 'string' ? message.delta : null);

        if (!text) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                subagentTitles,
                collabReceiverThreadIdsByCall,
                collabToolByCall,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    // exec_approval_request is intentionally NOT mapped here — the permission
    // handler already renders the approval UI via agent state.  Mapping it to
    // tool-call-start too would create a duplicate tool call card.
    if (type === 'exec_command_begin') {
        const call = pickCallId(message);
        const { call_id: _callIdSnake, callId: _callIdCamel, type: _type, ...args } = message;

        const command = summarizeCommand((args as Record<string, unknown>).command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexBash',
                title: commandToTitle(command),
                description,
                args: args as Record<string, unknown>,
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(
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
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, subagentTitles, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        startedSubagents,
        activeSubagents,
        providerSubagentToSessionSubagent,
        subagentTitles,
        collabReceiverThreadIdsByCall,
        collabToolByCall,
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

import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';
import { hashObject } from '@/utils/deterministicJson';
import {
    CODEX_HAPPY_SYSTEM_PROMPT_END,
    CODEX_HAPPY_SYSTEM_PROMPT_START,
    readPawsTurnOrigin,
    stripPawsTurnOrigin,
} from '../codexPrompt';
import {
    CodexMcpAppAdapter,
    type NormalizedCodexMcpAppCall,
} from '../mcpApps/CodexMcpAppAdapter';
import type { McpAppBindingRegistry } from '../mcpApps/McpAppBindingRegistry';

export type CodexTurnState = {
    currentTurnId: string | null;
    threadId?: string;
    mcpAppBindingRegistry?: McpAppBindingRegistry;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    textEnvelopeOccurrences?: Map<string, number>;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    startedSubagents: Set<string>;
    activeSubagents: Set<string>;
    providerSubagentToSessionSubagent: Map<string, string>;
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

const codexMcpAppAdapter = new CodexMcpAppAdapter();

function bindNormalizedMcpAppCall(
    registry: McpAppBindingRegistry | undefined,
    threadId: string | undefined,
    call: NormalizedCodexMcpAppCall,
): boolean {
    if (!registry || !threadId || !call.presentation) {
        return false;
    }
    registry.bindStarted({
        callId: call.callId,
        threadId,
        server: call.server,
        resourceUri: call.presentation.resourceUri,
        input: call.input,
        ...(call.connectorId ? { connectorId: call.connectorId } : {}),
        ...(call.presentation.appName ? { appName: call.presentation.appName } : {}),
        ...(call.presentation.actionName ? { actionName: call.presentation.actionName } : {}),
    });
    return true;
}

function hasMcpCompletionError(error: unknown): boolean {
    return error !== undefined
        && error !== null
        && !(typeof error === 'string' && error.trim().length === 0);
}

function isTrustedMcpCallCompletion(item: Record<string, unknown>): boolean {
    return item.status === 'completed' && !hasMcpCompletionError(item.error);
}

function historicalMcpCallSucceeded(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): boolean | null {
    if (isTrustedMcpCallCompletion(item)) {
        return true;
    }
    const status = item.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled'
        || status === 'aborted' || status === 'interrupted' || hasMcpCompletionError(item.error)) {
        return false;
    }
    return null;
}

export function rebuildCodexMcpAppBindings(
    thread: Pick<Thread, 'turns'>,
    opts: {
        threadId: string;
        mcpAppBindingRegistry: McpAppBindingRegistry;
    },
): void {
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            if (item.type !== 'mcpToolCall') {
                continue;
            }
            const mcpItem = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
            const normalized = codexMcpAppAdapter.normalizeItem(mcpItem);
            if (!bindNormalizedMcpAppCall(opts.mcpAppBindingRegistry, opts.threadId, normalized)) {
                continue;
            }
            const succeeded = historicalMcpCallSucceeded(mcpItem);
            if (succeeded !== null) {
                opts.mcpAppBindingRegistry.complete(normalized.callId, normalized.result, succeeded);
            }
        }
    }
}

function getStartedSubagents(state: CodexTurnState): Set<string> {
    return state.startedSubagents ?? new Set<string>();
}

function getActiveSubagents(state: CodexTurnState): Set<string> {
    return state.activeSubagents ?? new Set<string>();
}

function getProviderSubagentToSessionSubagent(state: CodexTurnState): Map<string, string> {
    return state.providerSubagentToSessionSubagent ?? new Map<string, string>();
}

const SUBAGENT_TURN_KEY_PREFIX = '\u0000turn:';
const COLLAB_CALL_KEY_PREFIX = '\u0000collab-call:';

function rememberSubagentTurn(
    mapping: Map<string, string>,
    subagent: string,
    turn: string | undefined,
): void {
    if (turn) {
        mapping.set(`${SUBAGENT_TURN_KEY_PREFIX}${subagent}`, turn);
    }
}

function getSubagentTurn(mapping: Map<string, string>, subagent: string): string | undefined {
    return mapping.get(`${SUBAGENT_TURN_KEY_PREFIX}${subagent}`);
}

function rememberCollabCallSubagent(mapping: Map<string, string>, call: string, subagent: string): void {
    mapping.set(`${COLLAB_CALL_KEY_PREFIX}${call}`, subagent);
}

function consumeCollabCallSubagent(mapping: Map<string, string>, call: string): string | undefined {
    const key = `${COLLAB_CALL_KEY_PREFIX}${call}`;
    const subagent = mapping.get(key);
    mapping.delete(key);
    return subagent;
}

function maybeEmitSubagentStart(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    providerSubagentToSessionSubagent: Map<string, string>,
    envelopes: SessionEnvelope[],
    title?: string,
): void {
    if (!subagent || startedSubagents.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
    }, { ...opts, subagent }));
    startedSubagents.add(subagent);
    activeSubagents.add(subagent);
    rememberSubagentTurn(providerSubagentToSessionSubagent, subagent, opts.turn);
}

function buildEnvelopeOptions(currentTurnId: string | null | undefined, subagent?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(subagent ? { subagent } : {}),
    };
}

function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [message.subagent, message.parent_call_id, message.parentCallId];
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

    return resolveProviderSubagent(providerSubagent, providerSubagentToSessionSubagent);
}

function resolveProviderSubagent(
    providerSubagent: string,
    providerSubagentToSessionSubagent: Map<string, string>,
): string {
    const existing = providerSubagentToSessionSubagent.get(providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    providerSubagentToSessionSubagent.set(providerSubagent, created);
    return created;
}

function pickReceiverThreadIds(message: Record<string, unknown>): string[] {
    const receiverThreadIds = message.receiver_thread_ids ?? message.receiverThreadIds;
    return Array.isArray(receiverThreadIds)
        ? receiverThreadIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
}

function collabAgentToolTitle(tool: unknown): string {
    switch (tool) {
        case 'spawnAgent':
            return 'Spawn agent';
        case 'sendInput':
            return 'Send input to agent';
        case 'resumeAgent':
            return 'Resume agent';
        case 'wait':
            return 'Wait for agents';
        case 'closeAgent':
            return 'Close agent';
        default:
            return 'Agent collaboration';
    }
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

export function extractSkillNamesFromCommand(command: string | null): string[] {
    if (!command) {
        return [];
    }

    const names = new Set<string>();
    const normalizedCommand = command.replaceAll('\\', '/');
    const shellWrapper = normalizedCommand.trim().match(
        /^(?:(?:[^\s"']*\/)?(?:zsh|bash|sh)|(?:[^\s"']*\/)?(?:powershell(?:\.exe)?|pwsh))\s+(?:-[a-z]*c|-Command)\s+(["'])([\s\S]*)\1$/i,
    );
    const executableCommand = shellWrapper?.[2] ?? normalizedCommand;
    const segments = executableCommand.split(/&&|\|\||;|\r?\n/);
    for (const segment of segments) {
        // A path mention is not proof that the skill was loaded. Only promote
        // commands whose purpose is to read file content; e.g. `git diff --
        // SKILL.md` must remain an ordinary terminal operation.
        const executedReader = /^(?:(?:command|sudo|env)\s+)*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)*(?:[^\s"']*\/)?(?:cat|sed|head|tail|less|more|bat|batcat|type|Get-Content)(?:\.exe)?(?:\s|$)/i;
        if (!executedReader.test(segment.trim())) {
            continue;
        }

        const pathPattern = /(["'])([^"'\r\n]*\/SKILL\.md)\1|([^\s"'`|&()<>]+\/SKILL\.md)/g;
        for (const match of segment.matchAll(pathPattern)) {
            const rawPath = match[2] ?? match[3];
            const parts = rawPath.split('/').filter(Boolean);
            const skillFileIndex = parts.lastIndexOf('SKILL.md');
            const skillsIndex = parts.lastIndexOf('skills');
            if (skillFileIndex < 1) {
                continue;
            }

            const skillName = parts[skillFileIndex - 1];
            const pluginsIndex = parts.lastIndexOf('plugins', skillFileIndex);
            let pluginName: string | null = null;
            if (pluginsIndex >= 0) {
                const pluginPathEnd = skillsIndex > pluginsIndex && skillsIndex < skillFileIndex
                    ? skillsIndex
                    : skillFileIndex - 1;
                const pluginPath = parts.slice(pluginsIndex + 1, pluginPathEnd);
                if (pluginPath[0] === 'cache') {
                    pluginPath.splice(0, Math.min(2, pluginPath.length));
                }
                if (pluginPath.length > 1 && /^\d+(?:\.\d+)*$/.test(pluginPath.at(-1) ?? '')) {
                    pluginPath.pop();
                }
                pluginName = pluginPath.at(-1) ?? null;
            }
            names.add(pluginName ? `${pluginName}:${skillName}` : skillName);
        }
    }

    return [...names];
}

function skillCommandTitle(skillNames: string[]): string {
    const rendered = skillNames.map((name) => `\`${name}\``).join(', ');
    return skillNames.length === 1 ? `Use skill ${rendered}` : `Use skills ${rendered}`;
}

function subagentTitle(message: Record<string, unknown>): string | undefined {
    const candidates = [message.prompt, message.agent_path, message.agentPath];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return undefined;
}

function startsSubagentLifecycle(tool: unknown): boolean {
    return tool === 'spawnAgent' || tool === 'resumeAgent' || tool === 'sendInput';
}

function turnTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function completedTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.completedAt ?? turn.startedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function stableTextEnvelopeId(opts: {
    turn?: string;
    subagent?: string;
    role: 'user' | 'agent';
    text: string;
    thinking?: boolean;
}, occurrence: number): string | undefined {
    if (!opts.turn) return undefined;
    return `codex-text:${hashObject({
        turn: opts.turn,
        subagent: opts.subagent ?? null,
        role: opts.role,
        text: opts.text.trim(),
        thinking: opts.thinking ?? false,
        occurrence,
    }, undefined, 'base64url')}`;
}

function nextTextEnvelopeOccurrence(
    occurrences: Map<string, number> | undefined,
    opts: { turn?: string; subagent?: string; role: 'user' | 'agent'; text: string; thinking?: boolean },
): number {
    if (!occurrences) return 0;
    const key = hashObject({
        turn: opts.turn ?? null,
        subagent: opts.subagent ?? null,
        role: opts.role,
        text: opts.text.trim(),
        thinking: opts.thinking ?? false,
    }, undefined, 'base64url');
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return occurrence;
}

function textFromInputItems(items: unknown, omitPawsOriginToken?: string): string | null {
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
        .join('\n');
    if (isCodexRuntimeContext(text)) {
        return null;
    }
    if (omitPawsOriginToken && readPawsTurnOrigin(text) === omitPawsOriginToken) {
        return null;
    }
    const visibleText = stripPawsTurnOrigin(stripHappySystemPromptBlocks(text)).trim();
    return visibleText.length > 0 ? visibleText : null;
}

function isCodexRuntimeContext(text: string): boolean {
    const trimmed = text.trim();
    return (
        (trimmed.includes('# AGENTS.md instructions') && trimmed.includes('<environment_context>'))
        || (
            trimmed.includes('# Options')
            && trimmed.includes('You have a way to give a user a easy way to answer your questions')
            && trimmed.includes('Whenever you need to show the user an image')
        )
    );
}

/**
 * The first message in a Codex thread carries Happy's app instructions as
 * prompt text. Keep them available to Codex, but exclude them when a fork
 * backfills the thread into Happy's user-facing transcript.
 */
function stripHappySystemPromptBlocks(text: string): string {
    let result = text;
    while (true) {
        const start = result.indexOf(CODEX_HAPPY_SYSTEM_PROMPT_START);
        if (start < 0) return result;

        const contentStart = start + CODEX_HAPPY_SYSTEM_PROMPT_START.length;
        const end = result.indexOf(CODEX_HAPPY_SYSTEM_PROMPT_END, contentStart);
        if (end < 0) return result;

        result = result.slice(0, start) + result.slice(end + CODEX_HAPPY_SYSTEM_PROMPT_END.length);
    }
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

function turnStatus(turn: ThreadTurn): TurnEndStatus | null {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    if (status && status !== 'completed') {
        return null;
    }
    return 'completed';
}

export function isTerminalCodexTurn(turn: ThreadTurn): boolean {
    return turnStatus(turn) !== null;
}

function emitHistoricalToolCall(
    envelopes: SessionEnvelope[],
    turn: ThreadTurn,
    item: ThreadItem,
    name: string,
    title: string,
    args: Record<string, unknown>,
    output: string | null,
): void {
    const time = turnTimestampMs(turn);
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

    const status = pickTurnEndStatus(item as unknown as Record<string, unknown>, 'historical_tool_end');
    const failure = getToolFailure(item as unknown as Record<string, unknown>, status);
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-end',
        call: item.id,
        status,
        ...(failure ? { error: failure } : {}),
    }, {
        ...opts,
        id: `${item.id}:end`,
        time: completedTimestampMs(turn),
    }));
}

function createMcpToolCallStartEnvelope(
    call: NormalizedCodexMcpAppCall,
    opts: CreateEnvelopeOptions,
): SessionEnvelope {
    const title = `${call.server}.${call.tool}`;
    return createEnvelope('agent', {
        t: 'tool-call-start',
        call: call.callId,
        name: 'McpTool',
        title,
        description: title,
        args: {
            server: call.server,
            tool: call.tool,
            arguments: call.input,
        },
        ...(call.presentation ? { mcpApp: call.presentation } : {}),
    }, { ...opts, id: `${call.callId}:start` });
}

function createMcpToolCallEndEnvelope(
    call: NormalizedCodexMcpAppCall,
    statusSource: Record<string, unknown>,
    opts: CreateEnvelopeOptions,
): SessionEnvelope {
    const status = pickTurnEndStatus(statusSource, 'mcp_tool_call_end');
    const failure = getToolFailure(statusSource, status);
    return createEnvelope('agent', {
        t: 'tool-call-end',
        call: call.callId,
        status,
        ...(failure ? { error: failure } : {}),
        ...(call.result ? { mcpAppResult: call.result } : {}),
    }, { ...opts, id: `${call.callId}:end` });
}

export function mapCodexThreadToSessionEnvelopes(
    thread: Pick<Thread, 'turns'>,
    opts?: {
        omitPawsUserMessagesFromOriginToken?: string;
        /** Reconnect catch-up prioritizes durable dialogue and avoids replaying
         * transient tool/reasoning events that may already have streamed live. */
        dialogueOnly?: boolean;
        /** For an active Turn, replay only its user request. Agent output may
         * still be streaming and is handled by the live notification path. */
        activeTurnsUserOnly?: boolean;
    },
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    // History and live mapping intentionally use independent counters. Given
    // the same ordered snapshot/events they derive the same occurrence IDs,
    // so overlap during thread/read is idempotent instead of consuming the
    // next occurrence and creating a duplicate.
    const textEnvelopeOccurrences = new Map<string, number>();

    for (const turn of thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        for (const item of turn.items ?? []) {
            if (opts?.activeTurnsUserOnly && !isTerminalCodexTurn(turn) && item.type !== 'userMessage') {
                continue;
            }
            if (
                opts?.dialogueOnly
                && item.type !== 'userMessage'
                && item.type !== 'agentMessage'
                && item.type !== 'exitedReviewMode'
            ) {
                continue;
            }
            switch (item.type) {
                case 'userMessage': {
                    const text = textFromInputItems(item.content, opts?.omitPawsUserMessagesFromOriginToken);
                    if (text) {
                        const textIdentity = { turn: turn.id, role: 'user' as const, text };
                        envelopes.push(createEnvelope('user', { t: 'text', text }, {
                            id: stableTextEnvelopeId(
                                textIdentity,
                                nextTextEnvelopeOccurrence(textEnvelopeOccurrences, textIdentity),
                            ),
                            turn: turn.id,
                            time: startedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'agentMessage': {
                    const text = typeof item.text === 'string' ? item.text.trim() : '';
                    if (text.length > 0) {
                        const textIdentity = { turn: turn.id, role: 'agent' as const, text };
                        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
                            id: stableTextEnvelopeId(
                                textIdentity,
                                nextTextEnvelopeOccurrence(textEnvelopeOccurrences, textIdentity),
                            ),
                            turn: turn.id,
                            time: completedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'exitedReviewMode': {
                    const review = (item as { review?: unknown }).review;
                    const text = typeof review === 'string'
                        ? review.trim()
                        : '';
                    if (text.length > 0) {
                        const textIdentity = { turn: turn.id, role: 'agent' as const, text };
                        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
                            id: stableTextEnvelopeId(
                                textIdentity,
                                nextTextEnvelopeOccurrence(textEnvelopeOccurrences, textIdentity),
                            ),
                            turn: turn.id,
                            time: completedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'reasoning': {
                    const text = reasoningText(item);
                    if (text) {
                        const textIdentity = { turn: turn.id, role: 'agent' as const, text, thinking: true };
                        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, {
                            id: stableTextEnvelopeId(
                                textIdentity,
                                nextTextEnvelopeOccurrence(textEnvelopeOccurrences, textIdentity),
                            ),
                            turn: turn.id,
                            time: startedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'commandExecution': {
                    const command = typeof item.command === 'string' ? item.command : '';
                    const skillNames = extractSkillNamesFromCommand(command);
                    emitHistoricalToolCall(
                        envelopes,
                        turn,
                        item,
                        skillNames.length > 0 ? 'Skill' : 'CodexBash',
                        skillNames.length > 0 ? skillCommandTitle(skillNames) : commandToTitle(command),
                        { command, cwd: item.cwd, ...(skillNames.length > 0 ? { skillNames } : {}) },
                        typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
                    );
                    break;
                }
                case 'fileChange': {
                    const title = 'Apply patch';
                    emitHistoricalToolCall(
                        envelopes,
                        turn,
                        item,
                        'CodexPatch',
                        title,
                        { changes: item.changes, status: item.status },
                        null,
                    );
                    break;
                }
                case 'mcpToolCall': {
                    const mcpItem = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
                    const normalized = codexMcpAppAdapter.normalizeItem(mcpItem);
                    const opts = {
                        turn: turn.id,
                        time: startedAt,
                        codexItemId: item.id,
                    } satisfies CreateEnvelopeOptions;
                    envelopes.push(createMcpToolCallStartEnvelope(normalized, opts));
                    envelopes.push(createMcpToolCallEndEnvelope(
                        normalized,
                        mcpItem as unknown as Record<string, unknown>,
                        { ...opts, time: completedAt },
                    ));
                    break;
                }
            }
        }

        const endStatus = turnStatus(turn);
        if (endStatus) {
            envelopes.push(createEnvelope('agent', { t: 'turn-end', status: endStatus }, {
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
    if (rawStatus === 'canceled' || rawStatus === 'aborted' || rawStatus === 'interrupted') {
        return 'cancelled';
    }

    const exitCode = message.exit_code ?? message.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
        return 'failed';
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

function readFailureText(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'detail', 'stderr', 'output', 'content']) {
        const text = readFailureText(record[key]);
        if (text) {
            return text;
        }
    }
    return null;
}

function truncateFailureText(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function getToolFailure(message: Record<string, unknown>, status: TurnEndStatus): {
    code?: string;
    summary: string;
    detail?: string;
} | undefined {
    if (status !== 'failed') {
        return undefined;
    }

    const detail = [
        message.error,
        message.stderr,
        message.output,
        message.aggregatedOutput,
        message.result,
        message.message,
        message.reason,
    ]
        .map(readFailureText)
        .find((value): value is string => value !== null);
    const exitCode = message.exit_code ?? message.exitCode;
    const fallback = typeof exitCode === 'number'
        ? `Command exited with code ${exitCode}.`
        : 'The tool reported a failure.';
    const summary = detail
        ? truncateFailureText(detail.split(/\r?\n/, 1)[0].trim() || fallback, 280)
        : fallback;
    const truncatedDetail = detail ? truncateFailureText(detail, 4000) : undefined;

    return {
        ...(typeof exitCode === 'number' ? { code: 'command_failed' } : {}),
        summary,
        ...(truncatedDetail && truncatedDetail !== summary ? { detail: truncatedDetail } : {}),
    };
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const eventTurnId = typeof message.turn_id === 'string' && message.turn_id.length > 0
        ? message.turn_id
        : null;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);

    if (type === 'task_started') {
        const providerTurnId = eventTurnId;
        const turnId = providerTurnId ?? createId();
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, {
            ...(providerTurnId ? { id: `${providerTurnId}:start` } : {}),
            turn: turnId,
        });
        if (activeSubagents.size === 0) {
            startedSubagents.clear();
        }
        return {
            currentTurnId: turnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        const completedTurnId = eventTurnId ?? state.currentTurnId;
        if (!completedTurnId) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: completedTurnId } satisfies CreateEnvelopeOptions;
        const status = pickTurnEndStatus(message, type);
        return {
            currentTurnId: state.currentTurnId === completedTurnId ? null : state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [createEnvelope('agent', {
                t: 'turn-end',
                status,
            }, {
                ...lifecycleOpts,
                id: `${completedTurnId}:end`,
            })],
        };
    }

    if (type === 'token_count') {
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [],
        };
    }

    if (type === 'collab_agent_tool_begin' || type === 'collab_agent_tool_end') {
        const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
        const opts = buildEnvelopeOptions(
            subagent ? (getSubagentTurn(providerSubagentToSessionSubagent, subagent) ?? state.currentTurnId) : state.currentTurnId,
            subagent,
        );
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);

        const call = pickCallId(message);
        if (type === 'collab_agent_tool_end') {
            const status = pickTurnEndStatus(message, message.error ? 'turn_aborted' : 'task_complete');
            envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call, status }, opts));
            const startedSubagent = consumeCollabCallSubagent(providerSubagentToSessionSubagent, call);
            if (startedSubagent && status !== 'completed' && activeSubagents.has(startedSubagent)) {
                const lifecycleTurn = getSubagentTurn(providerSubagentToSessionSubagent, startedSubagent)
                    ?? state.currentTurnId;
                activeSubagents.delete(startedSubagent);
                startedSubagents.delete(startedSubagent);
                envelopes.push(createEnvelope('agent', { t: 'stop', status }, buildEnvelopeOptions(lifecycleTurn, startedSubagent)));
            }
        } else {
            const receiverThreadIds = pickReceiverThreadIds(message);
            const receiverThreadId = receiverThreadIds.length === 1 ? receiverThreadIds[0] : undefined;
            const sessionSubagent = receiverThreadId
                ? resolveProviderSubagent(receiverThreadId, providerSubagentToSessionSubagent)
                : undefined;
            const tool = message.tool;
            const title = collabAgentToolTitle(tool);
            envelopes.push(createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'Agent',
                title,
                description: title,
                args: {
                    tool,
                    prompt: message.prompt,
                    model: message.model,
                    reasoningEffort: message.reasoning_effort ?? message.reasoningEffort,
                    receiverThreadIds,
                    ...(sessionSubagent ? { sessionSubagent } : {}),
                    ...(receiverThreadId ? { providerThreadId: receiverThreadId } : {}),
                },
            }, opts));
            if (sessionSubagent && startsSubagentLifecycle(tool)) {
                maybeEmitSubagentStart(
                    sessionSubagent,
                    buildEnvelopeOptions(state.currentTurnId, sessionSubagent),
                    startedSubagents,
                    activeSubagents,
                    providerSubagentToSessionSubagent,
                    envelopes,
                    subagentTitle(message),
                );
                rememberCollabCallSubagent(providerSubagentToSessionSubagent, call, sessionSubagent);
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'subagent_completed') {
        const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
        if (!subagent || !activeSubagents.has(subagent)) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const status = pickTurnEndStatus(message, message.error ? 'turn_aborted' : 'task_complete');
        const lifecycleTurn = getSubagentTurn(providerSubagentToSessionSubagent, subagent)
            ?? state.currentTurnId;
        activeSubagents.delete(subagent);
        startedSubagents.delete(subagent);
        const stopEnvelope = createEnvelope(
            'agent',
            { t: 'stop', status },
            buildEnvelopeOptions(lifecycleTurn, subagent),
        );
        // A provider thread can be reused for follow-up work after reporting a
        // completed turn. Keep its stable session owner and original turn so
        // late or resumed output remains nested under the Agent that spawned it.
        // Explicitly starting the same child again updates its turn ownership;
        // the whole mapping is reset together with the Codex thread state.
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [stopEnvelope],
        };
    }

    const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
    const rootTurnId = eventTurnId ?? state.currentTurnId;
    const opts = buildEnvelopeOptions(
        subagent ? (getSubagentTurn(providerSubagentToSessionSubagent, subagent) ?? rootTurnId) : rootTurnId,
        subagent,
    );

    if (type === 'mcp_tool_call_begin' || type === 'mcp_tool_call_end') {
        const call = message.mcp_call as NormalizedCodexMcpAppCall | undefined;
        if (!call || typeof call.callId !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }
        const isBound = bindNormalizedMcpAppCall(
            state.mcpAppBindingRegistry,
            typeof message.thread_id === 'string' && message.thread_id.length > 0
                ? message.thread_id
                : state.threadId,
            call,
        );
        if (type === 'mcp_tool_call_end' && isBound) {
            state.mcpAppBindingRegistry?.complete(
                call.callId,
                call.result,
                isTrustedMcpCallCompletion(message),
            );
        }
        const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;
        const envelopeOpts = {
            ...opts,
            ...(itemId ? { codexItemId: itemId } : {}),
        };
        const envelope = type === 'mcp_tool_call_begin'
            ? createMcpToolCallStartEnvelope(call, envelopeOpts)
            : createMcpToolCallEndEnvelope(call, message, envelopeOpts);
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [envelope],
        };
    }

    if (type === 'user_message') {
        const text = textFromInputItems(message.content);
        if (!text || subagent) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;
        const textIdentity = { ...opts, role: 'user' as const, text };
        const envelopeId = stableTextEnvelopeId(
            textIdentity,
            nextTextEnvelopeOccurrence(state.textEnvelopeOccurrences, textIdentity),
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [createEnvelope('user', { t: 'text', text }, {
                ...opts,
                ...(envelopeId ? { id: envelopeId } : {}),
                ...(itemId ? { codexItemId: itemId } : {}),
            })],
        };
    }

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const text = message.message.trim();
        const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;
        const textIdentity = { ...opts, role: 'agent' as const, text };
        const envelopeId = stableTextEnvelopeId(
            textIdentity,
            nextTextEnvelopeOccurrence(state.textEnvelopeOccurrences, textIdentity),
        );
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
            ...opts,
            ...(envelopeId ? { id: envelopeId } : {}),
            ...(itemId ? { codexItemId: itemId } : {}),
        }));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
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
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
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
        const skillNames = extractSkillNamesFromCommand(command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: skillNames.length > 0 ? 'Skill' : 'CodexBash',
                title: skillNames.length > 0 ? skillCommandTitle(skillNames) : commandToTitle(command),
                description,
                args: {
                    ...(args as Record<string, unknown>),
                    ...(skillNames.length > 0 ? { skillNames } : {}),
                },
            }, { ...opts, id: `${call}:start` })
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        const status = pickTurnEndStatus(message, type);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        const failure = getToolFailure(message, status);
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call,
            status,
            ...(failure ? { error: failure } : {}),
        }, { ...opts, id: `${call}:end` }));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
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
            }, { ...opts, id: `${call}:start` })
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, { ...opts, id: `${call}:end` }));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        startedSubagents,
        activeSubagents,
        providerSubagentToSessionSubagent,
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
        const text = message.message.trim();
        const textIdentity = { ...opts, role: 'agent' as const, text, thinking: true };
        return [createEnvelope('agent', {
            t: 'text',
            text,
            thinking: true,
        }, {
            ...opts,
            id: stableTextEnvelopeId(
                textIdentity,
                nextTextEnvelopeOccurrence(state.textEnvelopeOccurrences, textIdentity),
            ),
            codexItemId: message.id,
        })];
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

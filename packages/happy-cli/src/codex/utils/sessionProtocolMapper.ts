import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';

export type CodexTurnState = {
    currentTurnId: string | null;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
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

function turnStatus(turn: ThreadTurn): TurnEndStatus {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
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

    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-end',
        call: item.id,
        status: pickTurnEndStatus(item as unknown as Record<string, unknown>, 'historical_tool_end'),
    }, {
        ...opts,
        id: `${item.id}:end`,
        time: completedTimestampMs(turn),
    }));
}

export function mapCodexThreadToSessionEnvelopes(thread: Pick<Thread, 'turns'>): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];

    for (const turn of thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        for (const item of turn.items ?? []) {
            switch (item.type) {
                case 'userMessage': {
                    const text = textFromInputItems(item.content);
                    if (text) {
                        envelopes.push(createEnvelope('user', { t: 'text', text }, {
                            id: item.id,
                            time: startedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'agentMessage': {
                    const text = typeof item.text === 'string' ? item.text.trim() : '';
                    if (text.length > 0) {
                        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
                            id: item.id,
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
                        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
                            id: item.id,
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
                        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, {
                            id: item.id,
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
                    );
                    break;
                }
            }
        }

        envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
            id: `${turn.id}:end`,
            turn: turn.id,
            time: completedAt,
        }));
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

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);

    if (type === 'task_started') {
        const turnId = createId();
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
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
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
        const status = pickTurnEndStatus(message, type);
        return {
            currentTurnId: null,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            envelopes: [createEnvelope('agent', {
                t: 'turn-end',
                status,
            }, lifecycleOpts)],
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
    const opts = buildEnvelopeOptions(
        subagent ? (getSubagentTurn(providerSubagentToSessionSubagent, subagent) ?? state.currentTurnId) : state.currentTurnId,
        subagent,
    );

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

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, envelopes);
        envelopes.push(createEnvelope('agent', { t: 'text', text: message.message }, opts));
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
            }, opts)
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
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call, status }, opts));
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
            }, opts)
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
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
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

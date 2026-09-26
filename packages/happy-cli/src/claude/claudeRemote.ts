import { prepareClaudeProcessSandbox, type ClaudeProcessSandbox } from '@/sandbox/claudeProcessSandbox';
import type { SandboxConfig } from '@/persistence';
import type { SandboxPolicyMode } from '@/sandbox/sandboxPolicy';
import type { ClaudeLessonReviewLifecycle } from './session';
import type { LessonProposalTurn } from '@/utils/lessonProposalTurn';
import { EnhancedMode } from "./loop";
import { endManagedTurnInput } from '@/managed/managedGracefulStop';

/**
 * How long a managed provider gets to leave on its own once its turn's input
 * has ended, before anything forces it.
 */
const MANAGED_TURN_END_INPUT_BUDGET_MS = 30_000;
/**
 * How long an automation's one turn may keep its provider alive for the
 * background work it launched. Work that has not reported back by then is cut
 * off with the run, as all of it was before the run waited at all — a run
 * that never ends also keeps its automation from ever running again.
 */
const RUN_ONCE_BACKGROUND_WAIT_BUDGET_MS = 60 * 60_000;
import { spawn } from 'node:child_process';
import { bindManagedQueryOptions } from '@/launcher/managedClaudeOptions'
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { CHAT_TITLE_SYSTEM_PROMPT, saycodeOwnedSystemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "@/orchestrator/workerMcp";
import { McpRuntimeRecovery } from './mcpRuntimeRecovery';
import { McpConfigSynchronizer, type McpConfigSource } from './mcpConfigSynchronizer';
import type { McpRuntimeServerStatus } from '@slopus/happy-wire';
import { buildWorkerAgents, readWorkerConfigFromEnv } from "@/orchestrator/workerAgents";
import { buildSkillGovernanceOptions, readSkillGovernanceConfigFromEnv } from "@/orchestrator/skillGovernance";
import { isConnectorPlatformConfigured, readExpectedConnectors, readExpectedMcpServices } from '@/aplus/fetchAplusMcpServers';
import { buildConnectorToolGuidance, listExpectedMcpServices } from '@/aplus/connectorToolGuidance';
import { buildClaudeSystemPromptOptions } from './claudePrompt';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from '@/prompt/agentOrchestrationPrompt';
import { readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv';
import type { CheckpointSessionComposition, CheckpointTurnPreparation } from '@/checkpoint/checkpointSessionComposition';
import { CheckpointWriterProcessTree } from '@/checkpoint/checkpointWriterProcessTree';
import { randomUUID } from 'node:crypto';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { managedSettingSources } from '@/managed/managedStartup';
import type { LessonReviewWorker } from '@/memory/lessonReviewWorker';
import type { LessonTurnKind } from '@/memory/lessonTurnEvidence';
import {
    createLessonTurnObservations,
    type LessonTurnObservations,
} from '@/memory/lessonTurnObservations';
import type { LessonDeliveryTicket, LessonTurnHost } from '@/memory/lessonTurnHost';

export type ClaudeActiveInputSender = (text: string) => Promise<boolean>;

export type ClaudeTurnLatencyInput = {
    attribution: 'exclusive' | 'coalesced';
    inputCount: number;
    traces: Array<{ id: string; receivedAt: number; queueMs: number }>;
};

export type ClaudeTurnLatencyDiagnostic = {
    version: 1;
    type: 'turn-latency';
    id: string;
    attribution: ClaudeTurnLatencyInput['attribution'];
    inputCount: number;
    queueMs: number;
    sdkSubmitMs: number;
    firstSdkTextMs: number | null;
    outcome: 'text' | 'no-text';
};

/**
 * The provider's messages, except that when `release()` settles before the
 * provider's next message, its value is yielded in that message's place.
 *
 * A provider waiting on background work that never reports back stays
 * silent, so a wait on it cannot be bounded by a loop that only wakes on the
 * provider's messages.
 */
async function* releasableMessages(
    source: AsyncIterable<SDKMessage>,
    release: () => Promise<SDKMessage> | null,
): AsyncGenerator<SDKMessage, void, undefined> {
    const iterator = source[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    try {
        while (true) {
            pending ??= iterator.next();
            const released = release();
            const next = await (released
                ? Promise.race([pending, released.then((value) => ({ released: value }))])
                : pending);
            if ('released' in next) {
                yield next.released;
                continue;
            }
            pending = null;
            if (next.done) return;
            yield next.value;
        }
    } finally {
        if (pending) {
            // Ending the provider must not wait behind a read it may never answer.
            pending.catch(() => undefined);
            void Promise.resolve(iterator.return?.()).catch(() => undefined);
        } else {
            await iterator.return?.();
        }
    }
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    managedSettingsLockdown?: boolean,
    /** 관리 실행인가. 마지막 경계에서 계획을 덮을지 정한다. */
    managedRun?: boolean,
    /**
     * Watches the process the SDK spawns, for a managed run's EOF proof.
     *
     * Separate from `completeTurn`'s writer tree: that one is about tool
     * writes, this one is about whether the provider's own process finished on
     * its own. Optional, and its absence means the runtime cannot prove that —
     * which the quiescence gate turns into a refusal, never into a pass.
     */
    /** Called when this turn's input ended by exhaustion rather than a kill. */
    onInputExhausted?: () => void,
    /** How long the provider gets to leave on its own after its input ends. */
    turnEndInputBudgetMs?: number,
    providerExitObserver?: {
        watch: (child: { once: (event: 'exit', handler: (code: number | null, signal: string | null) => void) => unknown }) => void,
        /** Called at every kill or cancellation boundary, before any signal. */
        markForced: () => void,
        /** Code 0, no signal, nothing having asked it to die. */
        exitedCleanly: () => boolean,
    },
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal; toolUseID: string }) => Promise<PermissionResult>,
    /** Called when the Query object is ready — allows permission handler to call setPermissionMode */
    onQueryReady?: (query: { setPermissionMode: (mode: string) => Promise<void> }) => void,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /**
     * Project lesson recall and foreground candidate review for this session.
     *
     * Built by the runner from the daemon's trusted spawn context. Absent for
     * a managed run and for any installation without a lesson host, and when
     * it is absent this function behaves exactly as it did before.
     */
    lessonProposalTurn?: LessonProposalTurn,
    lessonReviewLifecycle?: ClaudeLessonReviewLifecycle,
    lessons?: {
        turn: LessonTurnHost | null,
        review: LessonReviewWorker | null,
        sessionKind: LessonTurnKind,
        observations: LessonTurnObservations,
        /** The authoritative Happy session id; absent disables lesson work. */
        sessionId: string | null,
    },
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,
    /** Orchestrator mode: inject worker MCP tools and system prompt */
    orchestratorMode?: boolean,
    /** MCP servers to add for orchestrator worker management */
    orchestratorMcpServers?: Record<string, unknown>,
    mcpConfig?: McpConfigSource,
    sandbox?: QueryOptions['sandbox'],
    sandboxConfig?: SandboxConfig,
    sandboxPolicyMode?: SandboxPolicyMode,
    permissionsDeny?: string[],

    // Dynamic parameters
    /**
     * `channelRequestId` marks a batch that carries an external messenger request
     * (Saycode specs/desktop-messenger-channels). Its presence is what stops the slash-command
     * parsing below from treating relayed user text as session control. Auto-routing ids are a
     * different thing that ordinary input carries too, so they are deliberately not read here.
     */
    nextMessage: () => Promise<{
        message: MessageParam['content'],
        mode: EnhancedMode,
        channelRequestId?: string,
        latency?: ClaudeTurnLatencyInput,
    } | null>,
    beforeTurn?: () => Promise<CheckpointTurnPreparation | void>,
    prepareChannelExecution?: (requestId: string) => Promise<boolean>,
    beginChannelExecution?: (requestId: string) => boolean,
    completeTurn?: CheckpointSessionComposition['completeTurn'],
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    /** Token-level partials. Never persisted — see streamDeltaRelay. */
    onStreamEvent?: (message: Extract<SDKMessage, { type: 'stream_event' }>) => void,
    onTurnLatency?: (diagnostic: ClaudeTurnLatencyDiagnostic) => void,
    onPromptSuggestionChange?: (suggestion: string | null) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    onMcpStatus?: (status: McpRuntimeServerStatus) => void,
    onMcpStatusReaderReady?: (reader: Pick<McpRuntimeRecovery, 'readStatuses'> | null) => void,
    onMcpControllerReady?: (controller: Pick<McpRuntimeRecovery, 'reconnectServer'> | null) => void,
    onActiveInputReady?: (sender: ClaudeActiveInputSender | null) => void,
    onSDKMetadata?: (metadata: { tools?: string[]; slashCommands?: string[]; mcpServers?: { name: string; status: string }[]; skills?: string[]; plugins?: { name: string; path: string }[] }) => void,
    exitAfterFirstTurn?: boolean,
    /** How long a run-once result may wait on background work before ending anyway. */
    backgroundWaitBudgetMs?: number,
}) {
    let processSandbox: ClaudeProcessSandbox | undefined;
    try {
        return await runClaudeRemote(opts, async input => {
            processSandbox = await prepareClaudeProcessSandbox(input);
            return processSandbox;
        });
    } finally {
        await processSandbox?.close();
    }
}

async function runClaudeRemote(
    opts: Parameters<typeof claudeRemote>[0],
    prepareSandbox: typeof prepareClaudeProcessSandbox,
) {
    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sandboxPolicyMode !== 'mandatory' && opts.sessionId && !opts.completeTurn && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Retained by Session across checkpoint/mode generations; each accepted input replaces its controller.
    const reviewLifecycle = opts.lessonReviewLifecycle ?? {
        controller: new AbortController(), completedAssistantTurns: 0,
    };
    let reviewAbort = reviewLifecycle.controller;
    const preemptReview = () => {
        opts.lessonProposalTurn?.cancel();
        reviewLifecycle.controller.abort();
        reviewAbort = new AbortController();
        reviewLifecycle.controller = reviewAbort;
        if (opts.signal?.aborted) reviewAbort.abort();
    };

    let activeTurnLatency: { input: ClaudeTurnLatencyInput; sdkSubmitMs: number } | null = null;
    const activateTurnLatency = (input: ClaudeTurnLatencyInput | undefined) => {
        if (!input || input.traces.length === 0) {
            activeTurnLatency = null;
            return;
        }
        activeTurnLatency = { input, sdkSubmitMs: performance.now() };
    };
    const finishTurnLatency = (outcome: ClaudeTurnLatencyDiagnostic['outcome']) => {
        const active = activeTurnLatency;
        activeTurnLatency = null;
        if (!active) return;
        const now = performance.now();
        for (const trace of active.input.traces) {
            try {
                opts.onTurnLatency?.({
                    version: 1,
                    type: 'turn-latency',
                    id: trace.id,
                    attribution: active.input.attribution,
                    inputCount: active.input.inputCount,
                    queueMs: trace.queueMs,
                    sdkSubmitMs: Math.max(0, active.sdkSubmitMs - trace.receivedAt),
                    firstSdkTextMs: outcome === 'text' ? Math.max(0, now - trace.receivedAt) : null,
                    outcome,
                });
            } catch {
                logger.debug('[claudeRemote] Turn latency diagnostic delivery failed');
            }
        }
    };
    const isTopLevelTextDelta = (message: Extract<SDKMessage, { type: 'stream_event' }>) => {
        if (message.parent_tool_use_id !== null) return false;
        const event = message.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
        return event.type === 'content_block_delta'
            && event.delta?.type === 'text_delta'
            && typeof event.delta.text === 'string'
            && event.delta.text.length > 0;
    };

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return 'not-started' as const;
    }
    preemptReview();
    opts.onPromptSuggestionChange?.(null);

    // Handle special commands (extract text for parsing when content is a block array)
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : (initial.message.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
    /*
     * Relayed channel text is never read as session control.
     *
     * This is a *second* parser, distinct from the one in `runClaude.onUserMessage`: a channel
     * turn reaches the queue through the session's own RPC and so never passes through that
     * handler, but it does arrive here — where `/clear` calls `onSessionReset` and returns before
     * the provider ever sees the message. Gating only the first parser would leave an external
     * sender able to wipe a session's context with seven characters.
     */
    const fromChannel = initial.channelRequestId !== undefined;
    const specialCommand = fromChannel ? { type: null } as const : parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        reviewLifecycle.completedAssistantTurns = 0;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        opts.onReady();
        return;
    }

    const initialTurn = await opts.beforeTurn?.();
    const providerPath = initialTurn?.providerPath ?? opts.path;
    const providerSandbox = initialTurn?.claudeSandbox ?? opts.sandbox;

    const processSandbox = opts.sandboxPolicyMode === 'mandatory'
        ? await prepareSandbox({
            sandboxConfig: opts.sandboxConfig,
            sessionPath: providerPath,
            additionalDenyRead: providerSandbox?.filesystem?.denyRead,
            additionalDenyWrite: providerSandbox?.filesystem?.denyWrite,
            mcpSocketPath: (opts.mcpServers?.happy as { env?: Record<string, string> } | undefined)?.env?.SAYCODE_MCP_SOCKET,
        }) : undefined;
    // Claude owns its separate-UID session state; the Happy UID cannot pre-read it.


    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const orchestratorPrompt = opts.orchestratorMode ? ORCHESTRATOR_SYSTEM_PROMPT : undefined;

    // Per-session orchestrator/worker delegation: when a cheaper worker model is
    // declared (via HAPPY_WORKER_MODEL, applied to process.env above), register a
    // `worker` subagent bound to it and tell the main model to delegate mechanical
    // work to it. No-op when unset, so single-model sessions are unchanged.
    const workerAgents = buildWorkerAgents(readWorkerConfigFromEnv(process.env));

    // Per-machine/session skill governance: when HAPPY_SETTING_SOURCES and/or
    // HAPPY_SKILL_ALLOWLIST are set (e.g. on a Saycode-managed machine), scope
    // down which filesystem settings and skills this session loads so that
    // user-installed workflow skills (which redefine planning/TDD/review the
    // same way Saycode's own orchestration does) don't leak into managed
    // sessions. No-op when unset, so existing sessions are unchanged.
    const skillGovernance = buildSkillGovernanceOptions(readSkillGovernanceConfigFromEnv(process.env));
    // A managed run loads no filesystem settings at all. A settings file's
    // `env` block is applied to the agent and takes precedence over the
    // environment this startup produced, so a `~/.claude/settings.json` left on
    // the runtime image could point the agent at a different gateway or a
    // different key after the approval was made. The empty list is explicit —
    // the SDK's default is to load every source Claude Code would.
    const settingSources = managedSettingSources(opts.managedSettingsLockdown, skillGovernance.settingSources);
    const mergedMcpServers = {
        ...opts.mcpServers,
        ...(opts.orchestratorMode ? opts.orchestratorMcpServers : {}),
    };
    const connectorGuidance = buildConnectorToolGuidance(listExpectedMcpServices({
        expectedConnectors: readExpectedConnectors(),
        expectedMcpServices: readExpectedMcpServices(),
        configuredServerNames: Object.keys(mergedMcpServers),
    }), { connectorPlatformConfigured: isConnectorPlatformConfigured() });
    const promptOptions = buildClaudeSystemPromptOptions({
        customSystemPrompt: initial.mode.customSystemPrompt,
        appendSystemPrompt: initial.mode.appendSystemPrompt,
        chatTitlePrompt: CHAT_TITLE_SYSTEM_PROMPT,
        saycodeSystemPrompt: saycodeOwnedSystemPrompt,
        agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
        orchestratorPrompt,
        workerDelegationPrompt: workerAgents.delegationPrompt,
        connectorGuidance,
        saycodeSystemPromptEnabled: initial.mode.saycodeSystemPromptEnabled,
        saycodePromptBlocks: initial.mode.saycodePromptBlocks,
    });

    const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
    const writerProcessTree = opts.completeTurn ? new CheckpointWriterProcessTree() : null;
    const assembledOptions: QueryOptions = {
        cwd: providerPath,
        additionalDirectories: readAdditionalDirectoriesEnvironment(process.env),
        resume: startFrom ?? undefined,
        mcpServers: hasMcpServers ? mergedMcpServers : undefined,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: promptOptions.customSystemPrompt,
        appendSystemPrompt: promptOptions.appendSystemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        effort: initial.mode.effort,
        agents: workerAgents.agents,
        settingSources: processSandbox ? [] : settingSources,
        skills: skillGovernance.skills,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal; toolUseID: string }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        settingsPath: processSandbox ? undefined : opts.hookSettingsPath,
        promptSuggestions: true,
        // The outer UID and OS boundary already covers Bash and every other tool.
        sandbox: processSandbox ? { enabled: false } : providerSandbox,
        permissionsDeny: opts.permissionsDeny,
        /*
         * Installed for a managed run as well as for checkpoint protection.
         *
         * A managed run needs the SDK's **own** process exit, observed from
         * the child object: the installed SDK's `waitForExit()` returns early
         * once `process.killed` is set, and Node sets that when a signal is
         * delivered rather than when the process dies. This seam is the only
         * place that holds the object the kernel reports to.
         */
        spawnClaudeCodeProcess: (processSandbox || writerProcessTree || opts.providerExitObserver)
            ? (spawnOptions) => {
                const child = processSandbox ? processSandbox.spawn(spawnOptions) : spawn(spawnOptions.command, spawnOptions.args, {
                    cwd: spawnOptions.cwd,
                    env: spawnOptions.env,
                    signal: spawnOptions.signal,
                    detached: true,
                    stdio: ['pipe', 'pipe', 'inherit'],
                });
                writerProcessTree?.track(child);
                // Per process, not per session: a restart is a different
                // process, and the exit that matters is the one this run's
                // provider actually had.
                opts.providerExitObserver?.watch(child);
                return child as NonNullable<QueryOptions['spawnClaudeCodeProcess']> extends (...args: any[]) => infer Result
                    ? Result
                    : never;
            }
            : undefined,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    /*
     * Lesson state for this session's turns.
     *
     * `pendingLessonTicket` is what makes "selected" and "delivered" two
     * different things here: recall fills it before a message is pushed, and
     * it is only acknowledged once the SDK reports the assistant actually
     * beginning that turn. A push onto the queue is not acceptance.
     *
     * It is turn-local by construction — cleared on acknowledgement and
     * overwritten by the next recall — so a late result cannot be attached to
     * a turn it did not belong to.
     */
    const lessonTurn = opts.lessons?.sessionId ? (opts.lessons.turn ?? null) : null;
    const lessonReview = opts.lessons?.sessionId ? (opts.lessons.review ?? null) : null;
    // Unknown means automation: a session this host cannot classify must not
    // be allowed to teach the project.
    const cancelProposal = () => opts.lessonProposalTurn?.cancel();
    opts.signal?.addEventListener('abort', cancelProposal, { once: true });
    const lessonSessionKind: LessonTurnKind = opts.lessons?.sessionKind ?? 'automation';
    const claudeTurnObservations = opts.lessons?.observations ?? createLessonTurnObservations();
    /*
     * The authoritative Happy session id, never a placeholder.
     *
     * A constructed one would attribute this session's traces and candidates
     * to an identity nobody can resolve, so without it there is no lesson work
     * at all.
     */
    const sessionIdForLessons = opts.lessons?.sessionId ?? null;
    /*
     * Stops recall and any running review the moment this run is torn down.
     * `opts.signal` is the caller's own cancellation, so it drives this too.
     */
    let pendingLessonTicket: LessonDeliveryTicket | null = null;
    const proposalToolCallIds = new Set<string>();
    /** Text of the user message each turn carried, for the review evidence. */
    let currentTurnMessages = [readTurnText(initial.message)];
    /**
     * One id per accepted user input, created once and shared by recall, the
     * acknowledgement and the evidence.
     *
     * Not `sessionId:counter`: a counter restarts at zero on resume, so a
     * resumed session reuses ids CML has already persisted — the same request
     * id with a different query is a conflict, and with the same query it
     * returns a stale cached answer.
     */
    let currentTurnId = `${sessionIdForLessons}:${randomUUID()}`;
    /**
     * Recalls lessons and returns the text to send.
     *
     * Bounded and never fatal: a slow or unreachable store yields the message
     * unchanged and the turn proceeds.
     */
/** The plain-text parts of a user message, for a recall query or evidence. */
function readTurnText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((block) => (block as { type?: unknown })?.type === 'text'
            && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => (block as { text: string }).text)
        .join('\n');
}

    /**
     * Recalls lessons for a turn and returns the content to send.
     *
     * The original content is preserved exactly when nothing is added.
     * Structured content carries attachments — images, documents — and an
     * earlier version flattened it to `''` to get a query string, which sent
     * an empty turn and dropped every attachment. The query is read from the
     * text blocks; the blocks themselves are never rewritten.
     *
     * When a block is added it is prepended as one more text block, so an
     * array stays an array and nothing already in it moves.
     */
    const recallWithLessons = async (
        content: string | ContentBlockParam[],
        turnId: string,
        signal: AbortSignal,
    ): Promise<{ content: string | ContentBlockParam[]; ticket: LessonDeliveryTicket | null }> => {
        if (!lessonTurn) return { content, ticket: null };
        const query = typeof content === 'string'
            ? content
            : content
                .filter((block): block is ContentBlockParam & { type: 'text'; text: string } =>
                    (block as { type?: unknown }).type === 'text'
                    && typeof (block as { text?: unknown }).text === 'string')
                .map((block) => block.text)
                .join('\n');
        if (!query.trim()) {
            return { content, ticket: null };
        }
        const outcome = await lessonTurn.recall({
            turnId,
            query,
            signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
        }).catch(() => null);
        if (!outcome || outcome.outcome !== 'selected') {
            return { content, ticket: null };
        }
        // Prepended, and clearly labelled as reference material — the same
        // shape the Codex path uses.
        return {
            content: typeof content === 'string'
                ? `${outcome.block}\n\n${content}`
                : [{ type: 'text', text: outcome.block } as ContentBlockParam, ...content],
            ticket: outcome.ticket,
        };
    };

    const isCommandInput = (content: unknown) => /^\/\S/.test(readTurnText(content).trimStart());
    let queryClosed = false;
    const withLessons = async (content: string | ContentBlockParam[]) => {
        // Native slash commands must remain the first provider input token.
        if (isCommandInput(content)) {
            pendingLessonTicket = null;
            opts.lessonProposalTurn?.cancel();
            return content;
        }
        const owningTurnId = currentTurnId;
        const owningSignal = reviewAbort.signal;
        const current = () => !queryClosed && currentTurnId === owningTurnId && !owningSignal.aborted && !opts.signal?.aborted;
        const recalled = await recallWithLessons(content, owningTurnId, owningSignal);
        if (!current()) return content;
        pendingLessonTicket = recalled.ticket;
        opts.lessonProposalTurn?.cancel();
        const instruction = lessonSessionKind === 'foreground' && !opts.signal?.aborted && lessonReview?.prepareReviewTurn && opts.lessonProposalTurn
            ? await opts.lessonProposalTurn.prepare(owningTurnId, () => lessonReview.prepareReviewTurn!()) : '';
        if (!current()) return content;
        if (!instruction) return recalled.content;
        return typeof recalled.content === 'string' ? `${instruction}\n\n${recalled.content}`
            : [{ type: 'text' as const, text: instruction }, ...recalled.content];
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    activateTurnLatency(initial.latency);
    messages.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content: await withLessons(initial.message),
        },
    });

    /*
     * 마지막 소비 경계.
     *
     * 관리 실행이면 여기서 계획이 옵션을 덮는다 — 내장 도구 없음, broker 하나,
     * 승인 프롬프트로 경계를 대신하지 않음, 파일시스템 설정 안 읽음, run 이
     * 확정한 모델·effort. 중간 계층에 뿌리면 그 계층이 mode 값으로 다시 덮거나
     * 필드를 몰라서 조용히 사라진다(실제로 `tools`·`effort` 가 그랬다).
     * 검증된 계획이 없으면 기존 동작으로 돌아가지 않고 여기서 멈춘다.
     */
    const sdkOptions = bindManagedQueryOptions(assembledOptions, {
        managed: opts.managedRun === true,
        env: process.env,
    });

    // A channel batch can already be outside MessageQueue2 while checkpoint preparation awaits.
    // Only this last synchronous boundary may claim it started; absent authority fails closed.
    if (initial.channelRequestId !== undefined
        && (await opts.prepareChannelExecution?.(initial.channelRequestId) !== true
        || opts.beginChannelExecution?.(initial.channelRequestId) !== true)) {
        return 'not-started' as const;
    }
    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });
    const mcpRecovery = new McpRuntimeRecovery(response, { onStatus: opts.onMcpStatus });
    opts.onMcpStatusReaderReady?.(mcpRecovery);
    const mcpConfigSynchronizer = opts.mcpConfig
        ? new McpConfigSynchronizer(response, { ...opts.mcpConfig, onStatus: opts.onMcpStatus })
        : null;

    // Expose query control methods to permission handler
    if (opts.onQueryReady) {
        opts.onQueryReady({
            setPermissionMode: (mode: string) => response.setPermissionMode(mode as any),
        });
    }

    updateThinking(true);
    let acceptsActiveInput = true;
    const sendActiveInput: ClaudeActiveInputSender = async (text) => {
        if (!acceptsActiveInput || messages.done || !text.trim()) {
            return false;
        }
        // A steer joins the provider turn already in flight. Its recall trace
        // is distinct, but its arrival cannot replace the turn whose result is
        // still pending.
        const owningTurnId = currentTurnId;
        preemptReview();
        const steerAbort = reviewAbort;
        const commandInput = isCommandInput(text);
        const recalled = commandInput ? { content: text, ticket: null } : await recallWithLessons(
            text,
            `${sessionIdForLessons}:${randomUUID()}`,
            steerAbort.signal,
        );
        // A steer joins this same provider turn, but invalidates its previous
        // draft. Re-authorize and send a fresh token for the corrected work.
        const current = () => acceptsActiveInput && !messages.done && !opts.signal?.aborted
            && !steerAbort.signal.aborted && currentTurnId === owningTurnId && reviewAbort === steerAbort;
        if (!current()) return false;
        const instruction = !commandInput && lessonSessionKind === 'foreground' && lessonReview?.prepareReviewTurn && opts.lessonProposalTurn
            ? await opts.lessonProposalTurn.prepare(owningTurnId, async () => {
                const prepared = await lessonReview.prepareReviewTurn!();
                return current() ? prepared : null;
            }) : '';
        if (!current()) return false;
        /*
         * The SDK exposes no event that proves this in-band steer was acted
         * upon. Keep its selected trace unacknowledged rather than treating an
         * assistant event for the already-running input as proof of delivery.
         */
        currentTurnMessages.push(readTurnText(text));
        messages.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: instruction ? `${instruction}\n\n${recalled.content}` : recalled.content },
        });
        return true;
    };
    opts.onActiveInputReady?.(sendActiveInput);
    let acceptsPromptSuggestion = false;
    /*
     * Background work an automation's one turn must outlive. Ending the input
     * at the first result used to kill these with the provider, and the run
     * reported success while the agents it launched were cut off mid-task.
     * Background shells are excluded: they are often servers that never end,
     * and tearing them down with the run is what they have always relied on.
     *
     * Held as ids rather than a count: a task's own notification removes it,
     * so the result of the turn it triggers is not held back by a level
     * message that has not caught up yet — the SDK leaves that order open.
     * A task that reported an end is never awaited again.
     */
    const awaitedBackgroundTaskIds = new Set<string>();
    const reportedBackgroundTaskIds = new Set<string>();
    /*
     * The latest held result, handled after all once the wait's budget runs
     * out, and the budget's expiry, armed at the first held result.
     */
    let heldResult: SDKMessage | null = null;
    let backgroundWaitExpiry: Promise<SDKMessage> | null = null;
    let backgroundWaitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of releasableMessages(response, () => backgroundWaitExpiry)) {
            // The held result again, its wait over: already forwarded once.
            const released = message === heldResult;
            if (released) backgroundWaitExpiry = null;
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            /*
             * The first provider event of this turn — the assistant starting
             * to answer — is the earliest point at which the input is known to
             * have been accepted. Acknowledging when the message was queued
             * would record a delivery that a failure before this point could
             * still have prevented.
             *
             * Its own catch: a memory failure must not enter the turn's error
             * handling, which would close the turn and write a failure into
             * the transcript.
             */
            /*
             * Tool calls the assistant is starting. Paired with their results
             * by `tool_use_id`, so parallel calls never cross — the same rule
             * the Codex path follows with `call_id`.
             */
            if (message.type === 'assistant' && Array.isArray((message as { message?: { content?: unknown } }).message?.content)) {
                for (const block of (message as { message: { content: unknown[] } }).message.content) {
                    const call = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
                    if (call.type !== 'tool_use' || typeof call.id !== 'string') continue;
                    if (call.name === 'mcp__happy__propose_lesson') { proposalToolCallIds.add(call.id); continue; }
                    const input = call.input as { command?: unknown; cwd?: unknown } | undefined;
                    claudeTurnObservations.commandStarted({
                        callId: call.id,
                        // A tool's command when it has one, its name otherwise:
                        // "the same check ran twice" has to mean something for
                        // tools that are not shell commands too.
                        command: input?.command ?? call.name,
                        cwd: input?.cwd,
                    });
                }
            }

            if (pendingLessonTicket && lessonTurn && message.type === 'assistant') {
                const ticket = pendingLessonTicket;
                pendingLessonTicket = null;
                await lessonTurn.acknowledge(ticket).catch(() => false);
            }

            if (message.type === 'prompt_suggestion') {
                if (acceptsPromptSuggestion) {
                    acceptsPromptSuggestion = false;
                    const suggestion = message.suggestion.trim();
                    if (suggestion) {
                        opts.onPromptSuggestionChange?.(suggestion);
                    }
                }
                continue;
            }

            // Partial assistant output is a preview, not transcript: keep it
            // out of the persisted onMessage path.
            if (message.type === 'stream_event') {
                if (isTopLevelTextDelta(message)) finishTurnLatency('text');
                opts.onStreamEvent?.(message);
                continue;
            }

            // Handle messages. During /compact, Claude emits the generated
            // summary as a normal assistant text message before the result.
            // Mark it so downstream UI/protocol mapping can treat it as
            // housekeeping instead of a real assistant response.
            const outboundMessage = isCompactCommand && message.type === 'assistant'
                ? { ...message, isCompactSummary: true } as SDKMessage
                : message;
            if (!released) opts.onMessage(outboundMessage);

            if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
                awaitedBackgroundTaskIds.clear();
                for (const task of message.tasks) {
                    if (task.ambient || task.task_type === 'local_bash' || reportedBackgroundTaskIds.has(task.task_id)) continue;
                    awaitedBackgroundTaskIds.add(task.task_id);
                }
            }
            if (message.type === 'system' && message.subtype === 'task_notification') {
                reportedBackgroundTaskIds.add(message.task_id);
                awaitedBackgroundTaskIds.delete(message.task_id);
            }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                // Emit SDK metadata (tools, slash commands) from init message
                if (opts.onSDKMetadata) {
                    opts.onSDKMetadata({
                        tools: systemInit.tools,
                        slashCommands: systemInit.slash_commands,
                        mcpServers: systemInit.mcp_servers?.map(s => ({ name: s.name, status: s.status })),
                        skills: systemInit.skills,
                        plugins: systemInit.plugins?.map(p => ({ name: p.name, path: p.path })),
                    });
                }

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id && processSandbox) {
                    opts.onSessionFound(systemInit.session_id);
                } else if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(providerPath, processSandbox?.claudeConfigDir);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`), 30000);
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    if (!found) {
                        // The transcript never landed on disk within the grace
                        // window. We still register the id so the (now
                        // bounded) scanner watcher can pick it up if it shows
                        // up late and otherwise drops it cleanly instead of
                        // wedging — but surface the anomaly so a stuck remote
                        // launch is visible in the app rather than a silent
                        // "dead instance".
                        logger.debug(`[claudeRemote] WARNING: session transcript ${systemInit.session_id} never appeared after 30s`);
                        opts.onCompletionEvent?.('⚠️ Claude session did not produce a transcript — the agent may be unresponsive. Try sending your message again.');
                    }
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                finishTurnLatency('no-text');
                if (opts.exitAfterFirstTurn && awaitedBackgroundTaskIds.size > 0 && !released) {
                    // The provider starts the next turn itself when that work
                    // reports back; the run ends at the result after it.
                    logger.debug(`[claudeRemote] Run-once result deferred: ${awaitedBackgroundTaskIds.size} background task(s) still running`);
                    heldResult = message;
                    backgroundWaitExpiry ??= new Promise((resolve) => {
                        backgroundWaitTimer = setTimeout(
                            () => resolve(heldResult!),
                            opts.backgroundWaitBudgetMs ?? RUN_ONCE_BACKGROUND_WAIT_BUDGET_MS,
                        );
                    });
                    continue;
                }
                if (released) {
                    logger.debug(`[claudeRemote] Run-once background wait ran out with ${awaitedBackgroundTaskIds.size} task(s) still running`);
                }
                acceptsPromptSuggestion = true;
                acceptsActiveInput = false;
                opts.onActiveInputReady?.(null);
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');

                /*
                 * A turn that reached a result ended normally. The worker
                 * validates a proposal produced by this same provider turn
                 * against its observed evidence, permissions and settings.
                 * Not awaited: candidate persistence never blocks the chat.
                 */
                /*
                 * Always taken, so nothing carries into the next turn — and
                 * discarded when the turn errored, because a turn that failed
                 * has no verified procedure in it.
                 */
                const observed = claudeTurnObservations.take();
                const proposal = opts.lessonProposalTurn?.take(currentTurnId) ?? {};
                const hadPriorAssistantTurn = reviewLifecycle.completedAssistantTurns > 0;
                const finishLessonReview = () => {
                    if (!(message as { is_error?: boolean }).is_error) reviewLifecycle.completedAssistantTurns += 1;
                    if (lessonReview && !(message as { is_error?: boolean }).is_error) {
                        void lessonReview.reviewFinishedTurn({
                            ...proposal,
                            record: {
                                sessionId: sessionIdForLessons!,
                                turnId: currentTurnId,
                                kind: lessonSessionKind,
                                endedNormally: true,
                                hadPriorAssistantTurn,
                                userMessages: currentTurnMessages,
                                agentSummary: observed.summary,
                                recoveredFailures: observed.recoveredFailures,
                            },
                            signal: opts.signal ? AbortSignal.any([reviewAbort.signal, opts.signal]) : reviewAbort.signal,
                        }).catch(() => undefined);
                    }
                };
                opts.onMcpControllerReady?.(mcpRecovery);

                await mcpRecovery.recoverFailedServers();

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                if (opts.completeTurn) {
                    const applyResult = await opts.completeTurn(async () => {
                        if (!writerProcessTree) {
                            throw new Error('checkpoint writer process tree is unavailable');
                        }
                        /*
                         * The input ends here, and the provider is given the
                         * chance to leave on its own before anything kills it.
                         *
                         * This used to be `messages.end()` followed
                         * immediately by `response.close()`. The end was real,
                         * but the kill right behind it meant the exit could
                         * never be a flush — and `response.close()` schedules
                         * a kill whose signal a handled exit does not report,
                         * so the exit alone reads exactly like a graceful end.
                         */
                        const observer = opts.providerExitObserver;
                        if (!observer) {
                            /*
                             * Ordinary checkpoint protection, unchanged: end
                             * the input and close. Waiting for an exit here
                             * would be waiting on an observation nothing is
                             * making, so it would always run out the budget.
                             */
                            messages.end();
                            await writerProcessTree.quiesce(() => response.close());
                            return;
                        }
                        const ended = await endManagedTurnInput({
                            endInput: () => { messages.end(); },
                            exitedCleanly: () => observer.exitedCleanly(),
                            forceClose: async () => {
                                // Recorded before the kill, not after.
                                observer.markForced();
                                await writerProcessTree.quiesce(() => response.close());
                            },
                            budgetMs: opts.turnEndInputBudgetMs ?? MANAGED_TURN_END_INPUT_BUDGET_MS,
                        });
                        if (ended.exhausted) opts.onInputExhausted?.();
                        if (ended.forced) return;
                        /*
                         * The provider left on its own, but its descendants
                         * may not have. The writers still have to be
                         * quiesced — that is the checkpoint's gate, not the
                         * provider's — and `quiesce` escalates to SIGTERM and
                         * then SIGKILL.
                         *
                         * So ask first, read-only. A writer killed by that
                         * escalation leaves the parent cgroup empty and the
                         * SDK root's exit still reading as clean: a
                         * manufactured proof one layer below the cgroup. The
                         * cleanup still happens, because leaving writers
                         * behind is worse — but the exit is no longer
                         * evidence, and the gate refuses on it.
                         */
                        if (writerProcessTree.hasRemainingWriters()) observer.markForced();
                        await writerProcessTree.quiesce(async () => undefined);
                    });
                    if (applyResult.status !== 'completed') {
                        throw new Error('checkpoint turn apply did not complete');
                    }
                    finishLessonReview();
                    opts.onReady();
                    return opts.exitAfterFirstTurn
                        ? 'turn-complete' as const
                        : 'protected-turn-complete' as const;
                }

                // Without checkpoint protection, the provider result is the
                // completion boundary. Protected turns must apply first.
                finishLessonReview();
                // Send ready event
                opts.onReady();

                if (opts.exitAfterFirstTurn) {
                    /*
                     * Automation's one turn. This used to return with the
                     * iterator still open, so the provider was torn down with
                     * its input never ended — an exhaustion that never
                     * happened, and a managed checkpoint that could never be
                     * proven.
                     */
                    if (opts.providerExitObserver) {
                        const ended = await endManagedTurnInput({
                            endInput: () => { messages.end(); },
                            exitedCleanly: () => opts.providerExitObserver?.exitedCleanly() ?? false,
                            // Nothing to force here: `claudeRemote` returning
                            // is what ends this run, and inventing a kill
                            // would make a clean exit unprovable.
                            forceClose: async () => undefined,
                            budgetMs: opts.turnEndInputBudgetMs ?? MANAGED_TURN_END_INPUT_BUDGET_MS,
                        });
                        if (ended.exhausted) opts.onInputExhausted?.();
                    }
                    return 'turn-complete' as const;
                }

                // Wait for next user message without blocking the message loop.
                // Background task messages (task_started, task_progress, task_notification)
                // continue flowing through while we wait for user input.
                opts.nextMessage().then(async (next) => {
                    if (queryClosed) return;
                    if (!next) {
                        messages.end();
                    } else {
                        preemptReview();
                        await mcpConfigSynchronizer?.sync();
                        try {
                            const nextTurn = await opts.beforeTurn?.();
                            if (nextTurn?.providerPath && nextTurn.providerPath !== providerPath) {
                                throw new Error('checkpoint protection requires a provider restart for the next turn');
                            }
                        } catch (error) {
                            messages.setError(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                        acceptsPromptSuggestion = false;
                        opts.onPromptSuggestionChange?.(null);
                        opts.onMcpControllerReady?.(null);
                        // 결과 직후 복구 뒤에도 다음 입력을 기다리는 동안 서버가
                        // 죽을 수 있다. 턴 dispatch 직전(= SDK 가 idle 인 경계)에
                        // 한 번 더 살린다. 턴이 끝난 뒤 복구하면 그 턴 전체를
                        // 도구 없이 돈다. Codex 의 recoverBeforeTurn 과 같은 취지다.
                        //
                        // 이 await 는 acceptsPromptSuggestion 플립 뒤에 와야 한다.
                        // 앞에 두면 직전 턴의 늦은 prompt_suggestion 이 새 턴으로
                        // 새어든다.
                        await mcpRecovery.recoverFailedServers();
                        mode = next.mode;
                        // Content can be structured blocks; only plain text is
                        // usable as a recall query or as review evidence — but
                        // the blocks themselves are what gets sent, so recall
                        // runs on the whole message rather than on a flattened
                        // copy that would drop every attachment.
                        currentTurnMessages = [readTurnText(next.message)];
                        currentTurnId = `${sessionIdForLessons}:${randomUUID()}`;
                        /*
                         * After the `acceptsPromptSuggestion` flip and the MCP
                         * recovery, for the reason the comment above gives: a
                         * result that arrives from the previous turn must not
                         * be attached to this one.
                         */
                        const withBlock = await withLessons(next.message);
                        if (queryClosed || messages.done || opts.signal?.aborted) return;
                        activateTurnLatency(next.latency);
                        messages.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: withBlock } });
                        // Steering may only follow the primary input, never overtake its recall.
                        acceptsActiveInput = true;
                        opts.onActiveInputReady?.(sendActiveInput);
                    }
                }).catch(() => {
                    messages.end();
                });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        /*
                         * The provider's own verdict on a tool call. `is_error`
                         * is what Claude reports; reading the result text and
                         * guessing would invent successes the agent never had.
                         * An aborted call verifies nothing either way.
                         */
                        if (c.type === 'tool_result' && c.tool_use_id && !proposalToolCallIds.delete(c.tool_use_id)) {
                            claudeTurnObservations.commandEnded({
                                callId: c.tool_use_id,
                                status: opts.isAborted(c.tool_use_id) ? 'cancelled' : 'completed',
                                exitCode: c.is_error === true ? 1 : 0,
                                output: typeof c.content === 'string' ? c.content : undefined,
                            });
                        }
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        clearTimeout(backgroundWaitTimer);
        opts.lessonProposalTurn?.cancel();
        opts.signal?.removeEventListener('abort', cancelProposal);
        queryClosed = true;
        acceptsActiveInput = false;
        opts.onActiveInputReady?.(null);
        opts.onMcpControllerReady?.(null);
        opts.onMcpStatusReaderReady?.(null);
        updateThinking(false);
        claudeTurnObservations.take();
        proposalToolCallIds.clear();
    }
    return undefined;
}

/** Orchestrates Codex sessions, initial prompts, MCP tools and session lifecycle. */
import type { CodexBackgroundTask } from './codexBackgroundTasks';
import { SessionLaunchControl } from '../sessionDrain/sessionLaunchControl';
import type { StandaloneLaunchBootstrap } from '../daemon/standaloneLaunchProtocol';
import { RuntimeProducerGate } from '../sessionDrain/runtimeProducerGate';
import { createLessonProposalTurn } from '@/utils/lessonProposalTurn';
import { CodexAuthRecovery } from './codexAuthRecovery';
import { render } from "ink";
import {
    createManagedGracefulStop,
    registerManagedGracefulStop,
} from '@/managed/managedGracefulStop';
import { reportManagedStopOutcome } from '@/managed/managedStartup';
import { MANAGED_STOP_CLEAN } from '@/managed/managedControlChannel';

/**
 * How long a managed Codex run waits for its app server to leave after its
 * stdin is closed.
 *
 * A budget that ran out is reported as a timeout, never folded into a clean
 * exit — that is how a provider that is still writing gets archived.
 */
const CODEX_END_INPUT_BUDGET_MS = 10_000;
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import { describeCodexFailure, describeCodexInactivityAbort } from './codexAbortNotice';
import type { ReasoningEffort } from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { installBroadKillShims } from '@/utils/broadKillShims';
import { Credentials, readSettings } from '@/persistence';
import { resolveSessionSandboxConfig } from '@/sandbox/resolveSessionSandboxConfig';
import { resolveSessionSandboxPolicyMode } from '@/sandbox/sandboxPolicy';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type CollectedBatch, type PendingAttachment, type QueueLatencyTrace } from '@/utils/MessageQueue2';
import { captureCodexLatencyTrace, createCodexTurnLatency, type CodexLatencyStage } from './codexTurnLatency';
import { ChannelPromptAcceptance, CHANNEL_ACK_DEADLINE_MS } from '@/channel/channelPromptAcceptance';
import { enqueueChannelTurn } from '@/channel/channelTurnEnqueue';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { createChangeTitleHandler, startHappyServer } from '@/claude/utils/startHappyServer';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';
import {
    fetchAplusMcpConfigSnapshot,
    fetchAplusMcpServersResult,
    mcpConfigFailureStatuses,
    isConnectorPlatformConfigured,
    readExpectedConnectors,
    readExpectedMcpServices,
    resolveMcpFloorServerNames,
} from '@/aplus/fetchAplusMcpServers';
import { buildConnectorToolGuidance, listExpectedMcpServices } from '@/aplus/connectorToolGuidance';
import { bridgeAplusMcpServers } from '@/aplus/mergeAplusMcpServers';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { initializeScopeReportSigner, takeScopeLaunchBootstrap } from '@/daemon/sessionWriteScopeReports';
import { encodeBase64 } from '@/api/encryption';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { createTerminationSignalHandler } from "@/codex/terminationSignals";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { resolveRemoteCodexPermissionMode } from './permissionMode';
import { isSandboxFallbackNetworkLoss } from './sandboxInitFailurePolicy';
import { readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv';
import { installCodexApprovalBoundary } from './utils/codexApprovalBoundary';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    type CodexTurnState,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { CodexMcpConfigSynchronizer } from './codexMcpConfigSynchronizer';
import {
    buildCodexMcpRecoveryMetadataStatuses,
    CodexMcpRuntimeRecovery,
} from './codexMcpRuntimeRecovery';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText, shouldHandleCodexClear } from './codexClearCommand';
import { createEnvelope, type McpRuntimeServerStatus } from '@slopus/happy-wire';
import { createManagedFollowUpHandler } from '@/managed/managedFollowUp';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import {
    resolveInitialSaycodeAppendSystemPrompt,
    resolveSaycodeAppendSystemPromptForMessage,
} from '@/prompt/promptProvenance';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import type { LessonReviewWorker } from '@/memory/lessonReviewWorker';
import { createLazyLessonSessionHost } from '@/memory/lessonSessionHost';
import { prepareCodexRecallHost, buildCodexMemoryReferenceBlock } from '@/memory/codexRecallHost';
import { prepareCodexIngestHost, type CodexIngestHost } from '@/memory/codexIngestHost';
import { readLessonOwner } from '@/memory/lessonOwnerMarker';
import type { LessonTurnKind } from '@/memory/lessonTurnEvidence';
import { createLessonTurnObservations } from '@/memory/lessonTurnObservations';
import type { LessonTurnHost } from '@/memory/lessonTurnHost';
import { resolveSessionMemoryScope } from '@/memory/memoryScope';
import {
    buildCodexDeveloperInstructions,
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    isSupportedCodexReasoningEffort,
    resolveCodexSaycodePromptBlocks,
    type CodexEnhancedMode,
} from './codexPrompt';
import { createCodexExecTitleRunner, isOffTurnTitleEligible } from './codexOffTurnTitle';
import { createOffTurnTitleJob, titleCoveredForTurn } from '@/utils/offTurnTitle';
import { discoverCodexSkillCommands } from './codexSkills';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from '@/prompt/agentOrchestrationPrompt';
import { consumeReconnectSessionEnvironment } from '@/daemon/reconnectSessionEnv';
import { mergeReconnectSessionMetadata } from '@/utils/reconnectSessionMetadata';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';
import {
    assertCodexAutomationServerAvailable,
    prepareCodexInitialPrompt,
    prepareCodexSessionStart,
} from './initialPrompt';
import {
    buildLocalAutoBootstrapDecision,
    buildManualAppliedDecision,
    isRoutingProtect,
    createDifficultyRoutingUnknownEvent,
    reconcileDecisionWithAppliedSettings,
    resolveDifficultyRouting,
} from '@/difficultyRoutingRuntime';
import { DifficultyRoutingCommitter } from '@/difficultyRoutingCommit';
import { consumeAutomationRunOnce } from '@/utils/automationRunOnce';
import { createCodexUsageEvent } from '@/usage/providerUsageAdapters';
import {
    consumePendingInitialAppendSystemPrompt,
    consumePendingInitialEffort,
    consumePendingInitialModel,
    consumePendingInitialSaycodePromptBlocks,
    consumePendingInitialSaycodeSystemPromptEnabled,
    resolveInitialPromptPermissionMode,
} from '@/utils/initialPrompt';
import {
    createSessionModelPinPublisher,
    publishedSessionModelPin,
    type SessionModelPin,
} from '@/utils/sessionModelPin';

import { registerCodexSteerHandler } from './codexSteerHandler';
import { createDeferredContinuationContextConsumer } from '@/utils/deferredContinuationContext';
import { createCheckpointSessionComposition } from '@/checkpoint/checkpointSessionComposition';
import { createCheckpointEventPublisher } from '@/checkpoint/checkpointEventPublisher';
import { describeCheckpointFailure } from '@/checkpoint/checkpointFailure';
import { isManagedBrokerServer } from '@/launcher/codexApproval';
import { resolveManagedCodexArguments } from '@/launcher/managedCodexOptions';
import { applyManagedGatewayEnvironment, applyManagedInitialPrompt, assertManagedWorkingDirectory, clearForeignSessionLineage, managedCodexProviderArguments, requireAccountMachineId, requireAccountToken } from '@/managed/managedStartup';
import type { RunnerPrincipal } from '@/claude/runClaude';
import { isDelegatedDifficultyRoutingMessage } from '@/difficultyRouting';

/** See the Claude counterpart. */
const CODEX_INITIAL_PROMPT_ACK_TIMEOUT_MS = 30_000;

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'yolo';

type ClaimedUserMessage = {
    message: UserMessage;
    attachmentsPromise: Promise<PendingAttachment[]>;
    latencyTrace?: QueueLatencyTrace;
};

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    principal: RunnerPrincipal;
    standaloneLaunch?: StandaloneLaunchBootstrap;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
    /**
     * Project lesson recall and background review for this session.
     *
     * Supplied by the daemon when it has an open store and an authenticated
     * identity for the project. Omitted for a managed run, for an install
     * without CML, and whenever the studio has no lesson host — and when it is
     * omitted the turn loop behaves exactly as it did before.
     */
    lessons?: {
        turn: LessonTurnHost | null;
        review: LessonReviewWorker | null;
        /** Decided by the daemon's markers, not guessed per message. */
        sessionKind: LessonTurnKind;
    };
}): Promise<void> {
    await initializeScopeReportSigner();
    const scopeLaunch = takeScopeLaunchBootstrap();
    const standaloneLaunch = opts.standaloneLaunch ?? scopeLaunch;
    // Shield killall/pkill against broad kills before anything is spawned —
    // Codex has no PreToolUse hook system, so the PATH shim is its only guard.
    const managedStartup = opts.principal?.kind === 'managed' ? opts.principal.startup : null;
    // Capture before checkpoint preparation changes provider cwd; not from turn metadata.
    const recallProjectPath = process.cwd();
    const recallHostEnvironment = { ...process.env };
    if (standaloneLaunch && (managedStartup || opts.startedBy !== 'daemon')) throw new Error('Standalone launch requires an unmanaged daemon session');
    const launchControl = standaloneLaunch ? await SessionLaunchControl.connect(standaloneLaunch) : undefined;
    try {
    const accountToken = opts.principal?.kind === 'account' ? opts.principal.credentials.token : null;
    if (managedStartup) {
        // Before every consumer, not merely before the API client. The initial
        // prompt is read out of the environment a few lines below, so applying
        // the envelope later means the child's first turn carries somebody
        // else's prompt — or none, and no acknowledgement for the one it was
        // launched to answer.
        assertManagedWorkingDirectory(process.cwd());
        // Before the reconnect environment is read, which happens within a few
        // lines and would otherwise resume a session this run has nothing to
        // do with — dropping its prompt on the way.
        clearForeignSessionLineage(process.env);
        applyManagedGatewayEnvironment(process.env, managedStartup.envelope);
        applyManagedInitialPrompt(process.env, managedStartup.envelope);
    }

    const deferredContinuation = createDeferredContinuationContextConsumer(process.env);
    installBroadKillShims();
    const automationRunOnceRequested = consumeAutomationRunOnce(process.env);
    const reconnectSession = consumeReconnectSessionEnvironment(process.env);
    const reconnectSessionId = reconnectSession?.id;
    const allowAutomationReconnectPrompt = process.env.HAPPY_AUTOMATION_RESUME_PROMPT === '1';
    delete process.env.HAPPY_AUTOMATION_RESUME_PROMPT;
    const preparedInitialPrompt = prepareCodexInitialPrompt({
        env: process.env,
        reconnectSessionId,
        automationRunOnceRequested,
        allowAutomationReconnectPrompt,
    });

    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = opts.principal.kind === 'managed'
        ? ApiClient.managed(opts.principal.startup.attachment)
        : await ApiClient.create(opts.principal.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    const additionalDirectories = readAdditionalDirectoriesEnvironment(process.env);
    let machineId = settings?.machineId;
    // daemon 이 서버 지시대로 넘긴 설정(AgentTask pr_review 의 networkMode:'allowed' 등)을
    // 로컬 머신 설정보다 우선한다. 이 배선이 없어서 agent=codex 워커가 샌드박스 없이 떴고,
    // Codex 네이티브 readOnly 정책으로 떨어져 lifecycle 콜백을 전부 놓쳤다.
    const sandboxPolicyMode = resolveSessionSandboxPolicyMode(process.env);
    const sandboxConfig = resolveSessionSandboxConfig({
        noSandbox: Boolean(opts.noSandbox),
        env: process.env,
        settings,
        policyMode: sandboxPolicyMode,
    });
    // See runClaude: a managed child has no account home and no machine id.
    if (!machineId && !managedStartup) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    // A managed child has no machine of its own; the runtime it runs inside is
    // the registered thing.
    if (!managedStartup) {
        await api.getOrCreateMachine({
            machineId: requireAccountMachineId(machineId),
            metadata: initialMachineMetadata
        });
    }

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
    // Requester identity from the daemon's spawn RPC (specs/session-created-by).
    const createdByAccountId = process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
    const createdByDisplayName = process.env.HAPPY_CREATED_BY_DISPLAY_NAME;

    const { state, metadata: freshMetadata } = createSessionMetadata({
        flavor: 'codex',
        // Discarded for a managed run: its session metadata comes from the
        // server, opened with the key this process was handed.
        machineId: machineId ?? '',
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
        ...(createdByAccountId ? { createdBy: { accountId: createdByAccountId, displayName: createdByDisplayName } } : {}),
    });

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        freshMetadata.skills = skillCommands;
        freshMetadata.slashCommands = Array.from(new Set([...(freshMetadata.slashCommands ?? []), ...skillCommands]));
    }

    // Resume-in-place must start from the latest server metadata snapshot.
    // Rebuilding a local document here can overwrite an existing title and
    // any provider fields while still satisfying the server CAS version.
    const metadata = mergeReconnectSessionMetadata(reconnectSession?.metadata, freshMetadata);

    let response: ApiSession | null;
    if (managedStartup) {
        // Looked up, proven against the key this process holds, and placed on
        // the runtime's project root before anything reads the path.
        response = managedStartup.attachment.session;
    } else if (reconnectSession) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            ...reconnectSession,
            metadata,
            agentState: state,
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }
    assertCodexAutomationServerAvailable({
        automationRunOnceRequested,
        serverAvailable: response !== null,
        prepared: preparedInitialPrompt,
    });
    if (standaloneLaunch && (!response || sandboxConfig?.checkpointProtection)) throw new Error('Standalone drain requires an online standard session');
    if (!response && sandboxConfig?.checkpointProtection) {
        throw new Error('checkpoint protection requires an authoritative server session');
    }
    const checkpointComposition = response
        ? await createCheckpointSessionComposition({
            provider: 'codex',
            platform: process.platform,
            projectPath: process.cwd(),
            sessionId: response.id,
            sandboxConfig,
            sandboxPolicyMode,
            env: process.env,
            checkpointEvents: sandboxConfig?.checkpointProtection
                ? createCheckpointEventPublisher({
                    token: requireAccountToken(accountToken),
                    sessionId: response.id,
                    encryption: {
                        encryptionKey: response.encryptionKey,
                        encryptionVariant: response.encryptionVariant,
                    },
                })
                : undefined,
        })
        : { sandboxConfig };

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let memoryIngestHost: CodexIngestHost | null = null;
    const pendingMemoryIngest = new Set<Promise<void>>();
    const waitingMemoryIngest = new Set<() => void>();
    const memoryIngestShutdown = new AbortController();
    let memoryIngestClose: Promise<void> | null = null;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    // Assigned after handleKillSession is defined; re-attached on session swap
    // so an offline-started session still exits when archived server-side.
    let onSessionArchived: ((archiveOpts?: { stampArchive?: boolean }) => void) | undefined;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        sessionOptions: standaloneLaunch ? { trackShutdownStorage: true } : undefined,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            if (onSessionArchived) {
                newSession.on('archived', onSessionArchived);
            }
        }
    });
    session = initialSession;
    /**
     * Owns the routing floor across accept → engine-apply. The floor is *not*
     * written when a turn is accepted; it is written when this runner hands the
     * batch's settings to the Codex engine below.
     */
    /**
     * Identifies one execution attempt. A provider-level retry of the same batch
     * reuses it, so a transport retry cannot inflate the router's stuck counter.
     */
    const difficultyRoutingCommitter = new DifficultyRoutingCommitter(
        session.getMetadata()?.difficultyRoutingState,
        {
            agent: 'codex',
            persist: (state) => session.updateMetadata((current) => ({
                ...current,
                difficultyRoutingState: state,
            })),
            emit: (envelope) => session.sendSessionProtocolMessage(envelope),
        },
    );

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages(response?.seq ?? 0);
        if (allowAutomationReconnectPrompt) {
            session.capRuntimeProcessedSeq(response?.seq ?? 0);
        }
        session.updateMetadata((meta) => mergeReconnectSessionMetadata(meta, freshMetadata));
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);
    /**
     * Correlation for a turn answering an external messenger request
     * (Saycode specs/desktop-messenger-channels). Set when the batch carrying it becomes the
     * running turn; the mapper consumes it on the `turn-start` it stamps.
     */
    let codexPendingRequestId: string | null = null;
    let codexCurrentRequestId: string | null = null;
    let shouldExit = false;
    let pending: CollectedBatch<EnhancedMode> | null = null;
    // Only a launch-bound local channel can invoke drain; never a session RPC.
    const runtimeGate = session.tracksShutdownStorage && !managedStartup ? new RuntimeProducerGate({
        hasUndeliveredInput: () => pending !== null || messageQueue.size() > 0,
        canFreezeInbound: () => !reconnectionHandle && session === initialSession && session.canFreezeInboundMessagesForShutdown(),
        freezeInbound: () => session.freezeInboundMessagesForShutdown(),
        stopLoop: () => { shouldExit = true; messageQueue.close(); },
    }) : undefined;

    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    // Daemon-provided per-spawn model/effort seed (HAPPY_INITIAL_MODEL /
    // HAPPY_INITIAL_EFFORT, e.g. automations). Consumed exactly once — read
    // then deleted so children never inherit. Effort is whitelisted against
    // ReasoningEffort; anything else falls back to the default.
    // Split out what the user actually asked for from the runtime fallback, so
    // callers can tell "no model was chosen" apart from "the default model".
    const explicitInitialModel = consumePendingInitialModel(process.env);
    const initialModelSeed = explicitInitialModel ?? DEFAULT_CODEX_MODEL;
    const rawInitialEffortSeed = consumePendingInitialEffort(process.env);
    if (rawInitialEffortSeed && !isSupportedCodexReasoningEffort(rawInitialEffortSeed)) {
        logger.debug(`[Codex] Ignoring invalid initial effort seed: ${rawInitialEffortSeed}`);
    }
    const explicitInitialEffort = isSupportedCodexReasoningEffort(rawInitialEffortSeed)
        ? rawInitialEffortSeed
        : undefined;
    const initialEffortSeed = explicitInitialEffort ?? DEFAULT_CODEX_EFFORT;
    const initialSaycodeSystemPromptEnabled = consumePendingInitialSaycodeSystemPromptEnabled(
        process.env,
    );
    const initialSaycodePromptBlocks = consumePendingInitialSaycodePromptBlocks(process.env);
    const initialAppendSystemPrompt = resolveInitialSaycodeAppendSystemPrompt({
        appendSystemPrompt: consumePendingInitialAppendSystemPrompt(process.env),
        saycodeSystemPromptEnabled: initialSaycodeSystemPromptEnabled,
    });
    let currentModel: string | undefined = initialModelSeed;
    let currentEffort: ReasoningEffort | undefined = initialEffortSeed;

    // The model/effort the *user* pinned, advertised on the session so another
    // device can carry on with the same model. Kept apart from currentModel:
    // that one always holds a concrete model, so publishing it would advertise
    // the runtime default as a deliberate choice and stop other clients from
    // routing a Default session themselves.
    const initialModelPin: SessionModelPin = {
        ...(explicitInitialModel ? { model: explicitInitialModel } : {}),
        ...(explicitInitialEffort ? { effort: explicitInitialEffort } : {}),
    };
    const sessionModelPinPublisher = createSessionModelPinPublisher({
        initialPin: initialModelPin,
        publishedPin: publishedSessionModelPin(metadata),
        updateMetadata: (update) => session.updateMetadata(update),
        onPublish: (patch) => logger.debug(`[Codex] Session model pin published: ${patch.currentModelCode ?? 'cleared'} / ${patch.currentThoughtLevelCode ?? 'cleared'}`),
    });
    // A session spawned with an explicit model must advertise it before any
    // message arrives — otherwise the first turn sent from another device is
    // the one that loses the pin.
    sessionModelPinPublisher.publish({ specifiesModel: false, specifiesEffort: false });
    let currentAppendSystemPrompt: string | undefined = initialAppendSystemPrompt;
    let currentSaycodeSystemPromptEnabled: boolean | undefined = initialSaycodeSystemPromptEnabled;
    let currentSaycodePromptBlocks: CodexEnhancedMode['saycodePromptBlocks'] = initialSaycodePromptBlocks;

    const resetTurnScopedOptions = () => {
        currentPermissionMode = DEFAULT_CODEX_PERMISSION_MODE;
        currentModel = initialModelSeed;
        currentEffort = initialEffortSeed;
        sessionModelPinPublisher.reset();
        // Cached append prompt and account preference survive turn-scoped abort resets.
        logger.debug('[Codex] Reset turn-scoped options after abort');
    };

    const lessonProposalTurn = createLessonProposalTurn();
    // Independent of provider/queue cancellation: a new message must stop an old
    // candidate write without interrupting the conversation it was queued behind.
    let lessonReviewAbort = new AbortController();
    let activeLessonTurn: {
        turnId: string;
        userMessages: string[];
        controller: AbortController;
        acceptingSteer: boolean;
        pendingSteer: boolean;
    } | null = null;
    const preemptLessonReview = () => {
        lessonReviewAbort.abort();
        lessonProposalTurn.cancel();
    };

    let activeLatency: ReturnType<typeof createCodexTurnLatency> = null;
    const handleUserMessage = createSerialAsyncHandler<ClaimedUserMessage>(async ({ message, attachmentsPromise, latencyTrace }) => {
        const delegatedDifficultyRoutingMessage = isDelegatedDifficultyRoutingMessage(message);

        const attachmentsForThisMessage = await attachmentsPromise;

        // Resolve permission mode (validated + downgrade-guarded in permissionMode.ts)
        const messagePermissionMode = resolveRemoteCodexPermissionMode(
            currentPermissionMode,
            message.meta?.permissionMode as PermissionMode | undefined,
        );
        if (messagePermissionMode !== currentPermissionMode) {
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] Keeping current permission mode: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            if (!delegatedDifficultyRoutingMessage) {
                currentModel = messageModel;
                logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
            } else {
                logger.debug(`[Codex] Auto-route fallback model received for this turn: ${messageModel || 'default'}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve effort — passed straight to sendTurnAndWait. Validate the
        // incoming value against ReasoningEffort so a stale/garbage entry on
        // the wire doesn't poison the per-turn options.
        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                if (!delegatedDifficultyRoutingMessage) currentEffort = undefined;
                logger.debug(`[Codex] Effort reset to default`);
            } else if (isSupportedCodexReasoningEffort(incoming)) {
                messageEffort = incoming;
                if (!delegatedDifficultyRoutingMessage) currentEffort = messageEffort;
                logger.debug(`[Codex] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[Codex] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        sessionModelPinPublisher.publish({
            specifiesModel: message.meta?.hasOwnProperty('model') ?? false,
            model: messageModel,
            specifiesEffort: message.meta?.hasOwnProperty('effort') ?? false,
            effort: messageEffort,
            source: message.meta?.modelSource,
        });

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        const hasAppendSystemPrompt = message.meta?.hasOwnProperty('appendSystemPrompt') ?? false;
        if (hasAppendSystemPrompt) {
            logger.debug(`[Codex] Append system prompt updated from user message: ${message.meta?.appendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        if (message.meta?.hasOwnProperty('saycodeSystemPromptEnabled')) {
            currentSaycodeSystemPromptEnabled = message.meta.saycodeSystemPromptEnabled ?? true;
            logger.debug(`[Codex] Saycode system prompt ${currentSaycodeSystemPromptEnabled ? 'enabled' : 'disabled'} by user message`);
        }

        currentSaycodePromptBlocks = resolveCodexSaycodePromptBlocks(
            currentSaycodePromptBlocks,
            message.meta,
        );

        messageAppendSystemPrompt = resolveSaycodeAppendSystemPromptForMessage({
            current: currentAppendSystemPrompt,
            incoming: message.meta?.appendSystemPrompt,
            hasIncoming: hasAppendSystemPrompt,
            saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
        });
        currentAppendSystemPrompt = messageAppendSystemPrompt;

        const outcome = !delegatedDifficultyRoutingMessage || isCodexClearText(message.content.text)
            ? null
            : await resolveDifficultyRouting({
                agent: 'codex',
                sourceMachineId: machineId ?? '',
                sessionId: response?.id ?? session.sessionId,
                contentText: message.content.text,
                meta: message.meta,
                current: { model: messageModel, effort: messageEffort },
                state: difficultyRoutingCommitter.current(),
            });

        /*
         * A protective decline is not "no opinion" — see runClaude for the full
         * rationale. `messageModel` already holds the client's candidate, which
         * on this path is the cheap one; keep the session's current setting
         * rather than silently downgrading the conversation.
         */
        if (outcome && isRoutingProtect(outcome)) {
            logger.debug(`[Codex] Auto-route declined protectively (${outcome.reason}); keeping current model`);
            messageModel = currentModel;
            messageEffort = currentEffort;
            const protectIntent = message.meta?.difficultyRoutingIntent as { clientRequestId?: string } | undefined;
            if (typeof protectIntent?.clientRequestId === 'string') {
                session.sendSessionProtocolMessage(createDifficultyRoutingUnknownEvent({
                    clientRequestId: protectIntent.clientRequestId,
                    reason: outcome.reason,
                    model: messageModel,
                    effort: messageEffort ?? null,
                }));
            }
        }
        const routed = outcome && !isRoutingProtect(outcome) ? outcome : null;

        // Not routed by us but still automatic, or an explicit manual pin. Both
        // are committed at the engine boundary through the same pending channel.
        const localRoutingRequestId = message.serverMessageId
            ? `message:${message.serverMessageId}`
            : message.localKey ? `local:${message.localKey}` : randomUUID();
        const localDecision = routed || isCodexClearText(message.content.text)
            ? null
            : message.meta?.modelSource === 'auto'
                ? buildLocalAutoBootstrapDecision({
                    agent: 'codex',
                    clientRequestId: localRoutingRequestId,
                    model: messageModel,
                    effort: messageEffort ?? null,
                    now: Date.now(),
                })
                : message.meta?.modelSource === 'user' && messageModel
                    ? buildManualAppliedDecision({
                        clientRequestId: localRoutingRequestId,
                        model: messageModel,
                        effort: messageEffort ?? null,
                        now: Date.now(),
                    })
                    : null;

        if (routed) {
            messageModel = routed.route.model ?? messageModel;
            if (isSupportedCodexReasoningEffort(routed.route.effort)) {
                messageEffort = routed.route.effort;
            }
            if (routed.event.ev.t === 'difficulty-routing') {
                routed.event.ev.result.model = messageModel ?? '';
                routed.event.ev.result.effort = messageEffort ?? null;
            }
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            appendSystemPrompt: messageAppendSystemPrompt,
            saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
            saycodePromptBlocks: currentSaycodePromptBlocks,
            effort: messageEffort,
        };
        const deferredTurn = deferredContinuation.prepare(message.content.text);
        let enqueueResult: ReturnType<typeof enqueueCodexUserText>;
        try {
            enqueueResult = enqueueCodexUserText({
                text: deferredTurn?.text ?? message.content.text,
                mode: enhancedMode,
                queue: messageQueue,
                attachments: attachmentsForThisMessage,
                latencyTrace,
                // Travels beside the mode so the engine boundary below can commit
                // this decision — and so a batch keeps every merged request's id.
                requestIds: routed
                    ? [routed.pending.clientRequestId]
                    : localDecision ? [localDecision.clientRequestId] : undefined,
            });
            deferredTurn?.commit();
            if (routed && enqueueResult === 'queued') {
                // Aligned to what the Codex client will actually be given — an
                // unsupported effort is dropped above, so the decision and the
                // engine would otherwise disagree. See runClaude for the full note.
                const reconciled = reconcileDecisionWithAppliedSettings(
                    routed.pending,
                    { model: messageModel, effort: messageEffort ?? null },
                    'codex',
                );
                if (reconciled) {
                    difficultyRoutingCommitter.recordPending(routed.state);
                    if (reconciled !== routed.pending) {
                        difficultyRoutingCommitter.recordLocalPending(reconciled);
                    }
                } else {
                    logger.debug('[Codex] Routed model was substituted into an unknown pair; no floor recorded');
                }
                session.sendSessionProtocolMessage(routed.event);
            } else if (localDecision && enqueueResult === 'queued') {
                const reconciled = reconcileDecisionWithAppliedSettings(
                    localDecision,
                    { model: messageModel, effort: messageEffort ?? null },
                    'codex',
                );
                if (reconciled) difficultyRoutingCommitter.recordLocalPending(reconciled);
            }
            if (enqueueResult === 'clear') {
                // Phase one: accepted, not yet reset. See DifficultyRoutingCommitter.
                difficultyRoutingCommitter.requestEpoch();
            }
        } catch (error) {
            deferredTurn?.rollback();
            throw error;
        }
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error) => {
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    });
    session.onUserMessage((message) => {
        // A managed run answers exactly the prompt its envelope was admitted
        // for. A message posted to this session by the account owner arrives
        // here as an ordinary user turn: it would change the model, the
        // permission mode and the system prompt, then queue another turn —
        // spending this run's capability on work that passed no admission and
        // silently replacing the selection that was priced. Refused before any
        // of that happens; a new prompt needs a new run.
        //
        // This is the general free-text path only. Permission answers and tool
        // responses arrive as their own RPCs, bound to an approval this run is
        // already waiting on, and are untouched.
        if (managedStartup) {
            logger.debug('[managed] Refusing a user turn that did not come from an admitted run');
            return;
        }
        const latencyTrace = captureCodexLatencyTrace(message.meta?.latencyTrace, diagnostic => session.sendTurnLatency(diagnostic));
        const accept = () => {
            preemptLessonReview();
            const attachmentsPromise = session.drainAttachmentsForUserMessage();
            return handleUserMessage({ message, attachmentsPromise, latencyTrace });
        };
        return runtimeGate ? runtimeGate.admit(accept).catch(error => {
            logger.warn('[Codex] User input admission refused', { errorName: error instanceof Error ? error.name : typeof error });
        }) : accept();
    });
    const deliverInitialPrompt = () => prepareCodexSessionStart({
        // An offline start has no session to confirm against; the guard above
        // (`assertCodexAutomationServerAvailable`) already refused that case,
        // and `prepareCodexSessionStart` refuses again if no confirmer reaches
        // it. This condition only supplies the confirmer when one can exist.
        ...(preparedInitialPrompt.requireConfirmedDelivery && response
            ? {
                confirmDelivery: (localId: string) => session.awaitMessageAck(
                    localId, CODEX_INITIAL_PROMPT_ACK_TIMEOUT_MS,
                ),
            }
            : {}),
        prepared: preparedInitialPrompt,
        sendSessionMessage: (envelope, localId) => session.sendSessionProtocolMessage(envelope, localId),
        pushPrompt: (prompt) => {
            messageQueue.unshiftIsolated(prompt, {
                permissionMode: resolveInitialPromptPermissionMode(
                    currentPermissionMode ?? 'default',
                    allowAutomationReconnectPrompt,
                ),
                model: currentModel,
                appendSystemPrompt: currentAppendSystemPrompt,
                saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
                saycodePromptBlocks: currentSaycodePromptBlocks,
                effort: currentEffort,
            });
            logger.debug('[START] Delivered initial prompt from HAPPY_INITIAL_PROMPT');
        },
        reportStarted: response ? async () => {
            try {
                logger.debug(`[START] Reporting session ${response.id} to daemon`);
                const result = await notifyDaemonSessionStarted(response.id, metadata, {
                    encryptionKey: encodeBase64(response.encryptionKey),
                    encryptionVariant: response.encryptionVariant,
                    seq: response.seq,
                    metadataVersion: response.metadataVersion,
                    agentStateVersion: response.agentStateVersion,
                });
                if (result.error) {
                    logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
                } else {
                    logger.debug(`[START] Reported session ${response.id} to daemon`);
                }
            } catch (error) {
                logger.debug('[START] Failed to report to daemon (may not be running):', error);
            }
        } : undefined,
    });
    const initialPromptDelivered = await (runtimeGate ? runtimeGate.admit(deliverInitialPrompt) : deliverInitialPrompt());
    // A run-once marker is only valid together with the fresh prompt supplied by
    // the automation daemon. This prevents an incomplete or accidentally resumed
    // startup from treating a later interactive message as the automation turn.
    const exitAfterFirstTurn = preparedInitialPrompt.exitAfterFirstTurn && initialPromptDelivered;
    let thinking = false;
    let currentTurnId: string | null = null;
    let currentProviderTurnId: string | null = null;
    /**
     * Provider turn id → the protocol turn it opened. Lives here, not on the per-call state object
     * the event handler rebuilds, because an approval arriving between two events has to find it.
     */
    const codexProviderTurnToProtocol = new Map<string, string>();
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        if (runtimeGate?.isClosed()) return;
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    /*
     * The lesson host for this session.
     *
     * Absent unless the daemon supplied one: a managed run has no account
     * bearer and therefore no grant, an install without CML has no store, and
     * both cases leave these null and the turn loop untouched.
     */
    /*
     * Built here, in the process that runs the turns.
     *
     * The daemon's supervisor lives in another process, so this session opens
     * its own — from the project id the daemon wrote into the spawn context
     * and a workspace the studio signs. `opts.lessons` stays injectable for
     * tests; production takes this path.
     *
     * Every failure resolves to null and the turn loop then behaves exactly as
     * it did before lessons existed.
     */
    const lessonSession = opts.lessons
        ? null
        : createLazyLessonSessionHost({
            accountToken,
            machineId: opts.principal?.kind === 'account' ? (machineId ?? null) : null,
            sessionId: session.sessionId,
            happyHomeDir: configuration.happyHomeDir,
            announceCandidate: (envelope) => session.sendSessionProtocolMessage(envelope),
        });
    const lessonTurn = opts.lessons?.turn ?? lessonSession?.turn ?? null;
    const lessonReview = opts.lessons?.review ?? lessonSession?.review ?? null;
    // Unknown means automation: a session this host cannot classify must not
    // be allowed to teach the project.
    const lessonSessionKind = opts.lessons?.sessionKind ?? lessonSession?.sessionKind ?? 'automation';
    /*
     * What this host watched each turn do. Fed from the provider's own
     * command events; a turn with nothing observed produces no candidate
     * rather than a procedure assembled from the question alone.
     */
    const codexTurnObservations = createLessonTurnObservations();
    /** Distinguishes turns within this session; also tells the first one apart. */
    let codexTurnCounter = 0;
    /**
     * One id per accepted user input, created once and shared by recall, the
     * acknowledgement and the evidence.
     *
     * Not `sessionId:counter`: a counter restarts at zero on resume, so a
     * resumed session reuses ids CML has already persisted — the same request
     * id with a different query is a conflict, and with the same query it
     * returns a stale cached answer.
     */
    let codexTurnId = '';

    let abortController = new AbortController();

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (runtimeGate?.isFrozen()) return;
        preemptLessonReview();
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetTurnScopedOptions();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    // `session` is swapped on offline reconnection, so resolve it at call time.
    const offTurnTitle = createOffTurnTitleJob({
        // Same payer and sandbox as the app-server; `client` is assigned before any turn runs.
        run: createCodexExecTitleRunner({ prepare: (args) => client.prepareSideCommand(args) }),
        changeTitle: (title, branchSlug) => createChangeTitleHandler(session)(title, branchSlug),
        hasTitle: () => session.hasTitle(),
        log: (message, detail) => logger.warn(message, detail),
    });

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async (killOpts?: { stampArchive?: boolean }) => {
        if (runtimeGate?.isFrozen()) {
            // The drain owns EOF and storage. A kill cannot race it by closing
            // the API or reporting a clean exit while a blocked child is live.
            const decision = await runtimeGate.waitForShutdownDecision();
            if (decision === 'blocked') throw new Error('Session shutdown is blocked with live runtime ownership');
            return;
        }
        runtimeGate?.beginTermination();
        // An admitted continuation may still await its provider acknowledgement.
        // Closing a worker host cannot settle that wait, so seal it before abort/join.
        cancelMemoryIngest();
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // This path exits directly rather than entering the loop's finally. Reap any
            // host memory writer before releasing the account session's ownership.
            await closeMemoryIngest();
            await Promise.all([...pendingMemoryIngest]);
            // Update lifecycle state to archived before closing —
            // unless the caller says the session may still be alive
            // server-side (sync-fatal 401/403), in which case leave the
            // metadata alone so the session stays resumable.
            if (session) {
                if (killOpts?.stampArchive ?? true) {
                    const lifecycleStateSince = Date.now();
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince,
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                }

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            offTurnTitle.cancel();
            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer.stop();

            // This RPC exits the process directly, so the loop's finally never runs — release the
            // reserved checkpoint workspace here too. specs/linux-checkpoint-enforcement-backend R4.
            try {
                await checkpointComposition.dispose?.();
            } catch (e) {
                logger.debug('[Codex] Error disposing checkpoint reservation during termination', e);
            }

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    if (runtimeGate) {
        session.rpcHandlerManager.registerHandler('killSession', async () => {
            if (runtimeGate.isFrozen()) {
                const decision = await runtimeGate.waitForShutdownDecision();
                return decision === 'blocked'
                    ? { success: false, message: 'Session shutdown is blocked with live runtime ownership' }
                    : { success: true, message: 'Session shutdown is completing' };
            }
            void handleKillSession();
            return { success: true, message: 'Killing happy-cli process' };
        });
    } else {
        registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);
    }

    // The daemon stops sessions with a bare SIGTERM (daemon/run.ts) — the idle
    // reaper, the stop-session RPC and Ctrl-C all land here, never on the
    // killSession RPC above. Without a handler Node's default disposition kills
    // us on the spot, so sendSessionDeath/flush/close never run and the tail of
    // the conversation is lost. runClaude has had these handlers all along;
    // the Codex runner never grew them.
    const handleTerminationSignal = createTerminationSignalHandler({
        terminate: handleKillSession,
        forceExit: (code) => {
            if (runtimeGate?.isFrozen()) {
                logger.warn('[Codex] Signal timeout cannot force-exit a frozen runtime with live ownership');
                return;
            }
            process.exit(code);
        },
    });
    process.on('SIGTERM', () => { void handleTerminationSignal('SIGTERM'); });
    process.on('SIGINT', () => { void handleTerminationSignal('SIGINT'); });

    // Exit when the session is archived/deleted server-side: the web archive
    // button (ephemeral with reason='archived') or a fatal 404 from the
    // message sync. Without this the syncs stop but the process lingers.
    // Mirrors the 'archived' listener in runClaude. Also attached to swapped
    // sessions via onSessionSwap (offline start → reconnect).
    onSessionArchived = (archiveOpts?: { stampArchive?: boolean }) => {
        logger.debug('[Codex] Session archived server-side, terminating...', archiveOpts);
        void handleKillSession(archiveOpts).catch(error => {
            logger.warn('[Codex] Archived session remains blocked with live runtime ownership', error);
        });
    };
    session.on('archived', onSessionArchived);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const memoryScope = resolveSessionMemoryScope({
        env: recallHostEnvironment,
        projectPath: recallProjectPath,
        sessionId: session.sessionId,
    });
    const projectMemoryPath = memoryScope.kind === 'project' ? memoryScope.projectPath : null;
    const recallHost = await prepareCodexRecallHost({
        accountOwned: opts.principal.kind === 'account',
        sandboxEnabled: checkpointComposition.sandboxConfig?.enabled === true,
        sandboxPolicyMode,
        projectPath: projectMemoryPath,
        env: recallHostEnvironment,
        report: ({ event, reason, contextChars }) => logger.debug('[CodexMemoryHost]', { event, reason, contextChars }),
    });
    logger.debug('[CodexMemoryHost]', { status: recallHost ? 'prepared' : sandboxPolicyMode === 'mandatory' ? 'policy_requires_binding' : 'unsupported' });
    memoryIngestHost = await prepareCodexIngestHost({
        accountOwned: opts.principal.kind === 'account',
        sandboxEnabled: checkpointComposition.sandboxConfig?.enabled === true,
        sandboxPolicyMode,
        projectPath: projectMemoryPath,
        env: recallHostEnvironment,
        report: result => logger.debug('[CodexMemoryIngest]', result),
    });
    logger.debug('[CodexMemoryIngest]', { status: memoryIngestHost ? 'prepared' : sandboxPolicyMode === 'mandatory' ? 'policy_requires_binding' : 'unsupported' });

    function cancelMemoryIngest(): void {
        if (!memoryIngestShutdown.signal.aborted) memoryIngestShutdown.abort();
        for (const cancel of [...waitingMemoryIngest]) cancel();
    }
    function closeMemoryIngest(): Promise<void> {
        if (!memoryIngestClose) memoryIngestClose = memoryIngestHost?.close() ?? Promise.resolve();
        return memoryIngestClose;
    }

    client = new CodexAppServerClient(
        checkpointComposition.sandboxConfig,
        checkpointComposition.beforeTurn,
        checkpointComposition.completeTurn,
        sandboxPolicyMode,
        // Explicit, and only ever from the verified envelope: it turns off the
        // account-rotation proxy and pins the provider this run may use.
        /*
         * B2 의 provider 고정 인자 뒤에 이 run 의 도구 경계(broker 등록·자격
         * 환경변수 이름·기능 차단·effort)를 얹는다. 관리 실행인데 검증된 계획이
         * 없으면 기존 동작으로 되돌아가지 않고 멈춘다.
         */
        resolveManagedCodexArguments({
            managed: managedStartup !== null,
            env: process.env,
            base: managedStartup ? managedCodexProviderArguments(managedStartup.envelope) : null,
        }),
        checkpointComposition.markTurnDispatched,
        recallHost !== null,
    );

    let ingestThreadMetadata: { threadId: string; path: Promise<string | null> } | null = null;
    let memoryIngestOrdinal = 0;
    const enqueuedIngestOrdinals = new Map<string, number>();
    const resolveIngestTranscript = (threadId: string, providerThread: { id: string; path: string } | null): Promise<string | null> => {
        // This snapshot survives checkpoint quiescence, which may have already stopped
        // the app-server. It was captured from thread/start, resume or fork.
        if (memoryIngestShutdown.signal.aborted) return Promise.resolve(null);
        if (providerThread?.id === threadId && providerThread.path) return Promise.resolve(providerThread.path);
        if (ingestThreadMetadata?.threadId === threadId) return ingestThreadMetadata.path;
        const cached = {
            threadId,
            path: (async () => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                let cancelled: (() => void) | undefined;
                try {
                    const result = await Promise.race([
                        client.readThread({ threadId, includeTurns: false }),
                        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); }),
                        new Promise<null>(resolve => {
                            if (memoryIngestShutdown.signal.aborted) { resolve(null); return; }
                            cancelled = () => resolve(null);
                            memoryIngestShutdown.signal.addEventListener('abort', cancelled, { once: true });
                        }),
                    ]);
                    return !memoryIngestShutdown.signal.aborted
                        && result?.thread.id === threadId && typeof result.thread.path === 'string' && result.thread.path
                        ? result.thread.path : null;
                } catch { return null; }
                finally {
                    if (timer) clearTimeout(timer);
                    if (cancelled) memoryIngestShutdown.signal.removeEventListener('abort', cancelled);
                }
            })(),
        };
        ingestThreadMetadata = cached;
        // Failed lookups may retry next completion. Concurrent completions share one
        // lookup, preserving prefix order rather than racing one read per turn.
        void cached.path.then(path => { if (!path && ingestThreadMetadata === cached) ingestThreadMetadata = null; });
        return cached.path;
    };
    const reserveCompletedTurnIngest = (threadId: string) => {
        const host = memoryIngestHost;
        if (!host) return undefined;
        const ordinal = ++memoryIngestOrdinal;
        let supply!: (completion: { throughTurnId: string; providerThread: { id: string; path: string } | null } | null) => void;
        const completion = new Promise<{ throughTurnId: string; providerThread: { id: string; path: string } | null } | null>(resolve => { supply = resolve; });
        let supplied = false;
        const settle = (native: { throughTurnId: string; providerThread: { id: string; path: string } | null } | null) => {
            if (supplied) return;
            supplied = true;
            waitingMemoryIngest.delete(cancel);
            supply(native);
        };
        const cancel = () => settle(null);
        waitingMemoryIngest.add(cancel);
        const work = async () => {
            try {
                const native = await completion;
                if (!native || memoryIngestShutdown.signal.aborted) return;
                // Resolve the owning rollout from the provider, never from a user-supplied
                // path or prompt. A stalled metadata read must not stall another turn.
                const transcriptPath = await resolveIngestTranscript(threadId, native.providerThread);
                if (!transcriptPath) {
                    logger.debug('[CodexMemoryIngest]', { reason: 'thread_unavailable' });
                    return;
                }
                // A reconnect can add metadata while an earlier lookup is pending. An
                // older resolved prefix must never replace an already queued newer one.
                if ((enqueuedIngestOrdinals.get(threadId) ?? 0) > ordinal) return;
                enqueuedIngestOrdinals.set(threadId, ordinal);
                await host.ingest({ threadId, transcriptPath, throughTurnId: native.throughTurnId });
            } catch {
                // Ingestion is optional and has its own failure boundary. Never turn a
                // successful provider completion into a failed foreground transcript.
                logger.debug('[CodexMemoryIngest]', { reason: 'thread_unavailable' });
            }
        };
        // Reserve while this foreground turn is still admitted. Shutdown may freeze
        // new work during inference; this trusted continuation belongs to that turn.
        const pending = (runtimeGate ? runtimeGate.admit(work, 'writer') : work()).catch(() => cancel());
        pendingMemoryIngest.add(pending);
        void pending.finally(() => pendingMemoryIngest.delete(pending));
        return {
            onCompleted: (throughTurnId: string, providerThread: { id: string; path: string } | null) => settle({ throughTurnId, providerThread }),
            onSettled: cancel,
        };
    };

    if (runtimeGate) client.setTurnDispatchHandler(() => runtimeGate.markDispatched());
    if (session.tracksShutdownStorage) {
        client.setOutputStorageGate({
            wait: signal => session.waitForStorageCapacity(signal),
            onFailure: () => session.markStorageOutputIncomplete(),
        });
    }

    const admitRpc = <T,>(work: () => Promise<T>): Promise<T> => runtimeGate ? runtimeGate.admit(work) : work();
    const authRecovery = new CodexAuthRecovery(client, () => shouldExit || thinking || messageQueue.size() > 0 || !!runtimeGate?.isClosed());
    session.rpcHandlerManager.registerHandler('codex-auth-status', async () => authRecovery.status());
    session.rpcHandlerManager.registerHandler('codex-auth-recover', async (params: Record<string, unknown>) =>
        runtimeGate?.isClosed() ? authRecovery.recover(params) : admitRpc(() => authRecovery.recover(params)));

    registerCodexSteerHandler({
        admit: admitRpc,
        client: {
            steerTurn: async (text) => {
                // Conservatively invalidate exclusive attribution even if steering later fails.
                activeLatency?.steered();
                const frame = activeLessonTurn;
                preemptLessonReview();
                if (!frame?.acceptingSteer) {
                    await client.steerTurn(text);
                    return;
                }
                const controller = new AbortController();
                lessonReviewAbort = controller;
                frame.controller = controller;
                frame.pendingSteer = true;
                const current = () => activeLessonTurn === frame && frame.acceptingSteer
                    && frame.controller === controller && !controller.signal.aborted;
                const instruction = lessonSessionKind === 'foreground' && lessonReview?.prepareReviewTurn
                    ? await lessonProposalTurn.prepare(frame.turnId, async () => {
                        const prepared = await lessonReview.prepareReviewTurn!();
                        return current() ? prepared : null;
                    }) : '';
                if (!current()) throw new Error('The owning turn ended before steering was accepted');
                try {
                    await client.steerTurn(instruction ? `${instruction}\n\n${text}` : text);
                    if (current()) { frame.userMessages.push(text); frame.pendingSteer = false; }
                } catch (error) {
                    if (current()) preemptLessonReview();
                    throw error;
                }
            },
        },
        session,
        managedRun: managedStartup !== null,
        onFailure: (message) => {
            logger.debug(`[Codex] Active-turn steer failed: ${message}`);
        },
    });

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        /*
         * The same refusal the `goal-action` RPC makes, here at the one place a
         * `/goal` text is executed — whichever way it reached the queue. A
         * managed run answers the prompt it was admitted for; a goal is an
         * instruction carried into every turn after it. Clearing removes one.
         */
        if (managedStartup && command.type === 'set') {
            messageBuffer.addMessage('A managed run cannot be given a new objective', 'status');
            return true;
        }
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch (error) {
            logger.debug('[Codex] Goal command API failed; falling back to normal turn:', error);
            return false;
        }
    };
    /**
     * The next turn of a managed session, relayed by the server on a
     * `message-send` bearer's behalf (T07-L5-b). Text only, queued with the
     * options the run already has — see runClaude.ts for the full rationale.
     */
    session.rpcHandlerManager.registerHandler('follow-up', createManagedFollowUpHandler({
        managed: () => Boolean(managedStartup),
        // The visible user row, so the transcript shows the turn where it came from.
        echo: ({ text, localId }) => session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }), localId),
        // Straight onto the queue: the parse already refused queue commands,
        // and the command-reading path would drop the turns already taken.
        enqueue: (text) => {
            messageQueue.push(text, {
                permissionMode: currentPermissionMode || 'default',
                model: currentModel,
                appendSystemPrompt: currentAppendSystemPrompt,
                saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
                saycodePromptBlocks: currentSaycodePromptBlocks,
                effort: currentEffort,
            }, []);
            logger.debug('[managed] Follow-up turn queued');
        },
    }));

    /*
     * External messenger channel ingress (Saycode specs/desktop-messenger-channels — R10/R12).
     *
     * Same contract as the Claude loop: the capability answer names *this* process, and the
     * delivery names the process it was authorized against, so a runtime replaced between the two
     * refuses instead of taking work whose capability was never checked. A runtime without these
     * handlers answers "unknown method", which is the old-runtime refusal.
     */
    session.rpcHandlerManager.registerHandler('channel-capability', async () => ({
        protocolVersion: 1,
        supportsChannelCancellation: true,
        supportsChannelExecutionApproval: true,
        engine: 'codex',
        // Same managed-run rule as the Claude loop; see ChannelAcceptanceDeps.isManagedRun.
        honoursChannelOrigin: !managedStartup,
        runtimeId: session.runtimeId,
    }));

    const channelAcceptance = new ChannelPromptAcceptance({
        runtimeId: session.runtimeId,
        requestApproval: ({ requestId, runtimeId, nonce }) => session.sendSessionProtocolMessage(
            createEnvelope('agent', { t: 'channel-ready', requestId, runtimeId, nonce })),
        isManagedRun: () => Boolean(managedStartup),
        recordDurably: async ({ text, localId }) => {
            const ack = session.awaitMessageAck(localId, CHANNEL_ACK_DEADLINE_MS);
            session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }), localId);
            const outcome = await ack;
            // Every negative outcome is ambiguous: `onSyncFatal` settles all waiters at once, and
            // a close can arrive after the server has already committed the row.
            return outcome.ok ? { ok: true as const } : { ok: false as const, provenNotWritten: false };
        },
        enqueue: (input) => enqueueChannelTurn(input, () => ({
            permissionMode: currentPermissionMode || 'default',
            model: currentModel,
            appendSystemPrompt: currentAppendSystemPrompt,
            saycodeSystemPromptEnabled: currentSaycodeSystemPromptEnabled,
            saycodePromptBlocks: currentSaycodePromptBlocks,
            effort: currentEffort,
        }), { queue: messageQueue, deferredContinuation }),
        now: () => Date.now(),
    });
    // Accepting a channel prompt records a user row and queues a turn, so it is input work:
    // after a shutdown freeze it is refused before anything is recorded (a retry starts clean).
    session.rpcHandlerManager.registerHandler('channel-prompt', async (params: unknown) =>
        runtimeGate?.isClosed()
            ? { ok: false as const, error: 'this session is shutting down' }
            : admitRpc(() => channelAcceptance.accept(params)));
    session.rpcHandlerManager.registerHandler('channel-authorize', async (params: unknown) => channelAcceptance.authorize(params));
    session.rpcHandlerManager.registerHandler('channel-cancel', async (params: unknown) => {
        const result = channelAcceptance.cancel(params);
        if (result.ok && result.state === 'cancelled') {
            messageQueue.removeByRequestId((params as { requestId: string }).requestId);
        }
        return result;
    });

    session.rpcHandlerManager.registerHandler('goal-action', (params: Record<string, unknown>) => admitRpc(async () => {
        authRecovery.assertReady();
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }
        if (managedStartup && command.type === 'set') {
            // A managed run answers exactly the prompt its envelope was
            // admitted for. A goal carries a free-text instruction into every
            // turn after it — work no admission covered. Refused here, before
            // the thread or the provider is touched; clearing a goal removes an
            // instruction rather than adding one, so it stays.
            throw new Error('A managed run cannot be given a new objective');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await handleCodexGoalCommand(command, threadId);
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    }));

    // Approval handler: routes server → client approval requests to our permission handler.
    // Installed from its own module so the path an app-server request takes is the tested one.
    installCodexApprovalBoundary({
        // The boundary installs the handler; shutdown also needs the pending-approval
        // cancellation hook on the same install, so it is attached here.
        client: {
            setApprovalHandler: (handler) => client.setApprovalHandler(handler, () => permissionHandler.closeForShutdown()),
            get threadId() { return client.threadId; },
        },
        permissionHandler,
        runtimeId: session.runtimeId,
        turnState: () => ({
            currentTurnId,
            currentRequestId: codexCurrentRequestId,
            providerTurnToProtocol: codexProviderTurnToProtocol,
        }),
        /*
         * 이 run 이 스스로 등록한 broker 로의 호출은 사람에게 물을 것이 없다 —
         * 그 서버를 등록한 것이 우리이고, 어떤 도구를 쓸 수 있는지는 broker 가
         * grant scope 로 최종 강제한다. 그 밖의 승인은 전부 기존 경로 그대로다.
         */
        isAutoApproved: (params) => isManagedBrokerServer({
            managed: managedStartup !== null,
            env: process.env,
            serverName: params.serverName,
        }),
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        if (msg.type === 'agent_message_delta' && typeof msg.delta === 'string') activeLatency?.text(msg.delta);
        else if (msg.type === 'agent_message' && typeof msg.message === 'string') activeLatency?.text(msg.message);
        else if (['task_started', 'agent_reasoning_delta', 'agent_reasoning', 'exec_command_begin', 'mcp_tool_call_begin'].includes(msg.type)) activeLatency?.activity();
        // Text deltas arrive many times per second. Logging their full body would
        // stringify every preview frame and duplicate the answer in debug logs.
        if (msg.type !== 'agent_message_delta') {
            logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);
        }

        if (msg.type === 'background_tasks') {
            const tasks = msg.tasks as CodexBackgroundTask[];
            session.updateMetadata(current => ({ ...current, codexBackgroundTasks: tasks }));
            return;
        }
        if (msg.type === 'codex_usage') {
            try {
                session.sendProviderUsageEvent(createCodexUsageEvent({
                    sessionId: session.sessionId,
                    responseId: String(msg.response_id ?? ''),
                    occurredAt: Date.now(),
                    model: currentModel ?? DEFAULT_CODEX_MODEL,
                    usage: msg.usage as Parameters<typeof createCodexUsageEvent>[0]['usage'],
                }));
            } catch (error) {
                logger.warn('[Codex] Failed to normalize provider usage data:', error);
            }
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message_delta') {
            const messageId = typeof msg.item_id === 'string' ? msg.item_id : null;
            const index = typeof msg.index === 'number' ? msg.index : null;
            const offset = typeof msg.offset === 'number' ? msg.offset : null;
            const delta = typeof msg.delta === 'string' ? msg.delta : null;
            if (messageId && index !== null && offset !== null && delta !== null) {
                session.sendStreamDelta({
                    messageId,
                    index,
                    offset,
                    delta,
                    final: msg.final === true,
                });
            }
        } else if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
            codexTurnObservations.commandStarted({
                callId: (msg as any).call_id ?? (msg as any).callId,
                command: (msg as any).command,
                cwd: (msg as any).cwd,
            });
        } else if (msg.type === 'exec_command_end') {
            /*
             * The provider's own exit status, classified there rather than
             * here. `exit_code` is `item.exitCode ?? null`, so an unknown
             * exit must not read as a success — a cancelled or declined
             * command verifies nothing.
             */
            codexTurnObservations.commandEnded({
                callId: (msg as any).call_id ?? (msg as any).callId,
                command: (msg as any).command,
                cwd: (msg as any).cwd,
                exitCode: (msg as any).exit_code,
                status: (msg as any).status,
                output: (msg as any).output ?? (msg as any).error,
            });
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            // Codex may settle a watchdog interrupt with status 'completed', so the
            // inactivity notice applies here too, not just to turn_aborted.
            const inactivityNotice = describeCodexInactivityAbort(msg);
            const failure = describeCodexFailure(msg);
            if (inactivityNotice) {
                const message = failure ? `${inactivityNotice} Provider error: ${failure}` : inactivityNotice;
                messageBuffer.addMessage(message, 'status');
                session.sendSessionEvent({ type: 'message', message });
            } else if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const inactivityNotice = describeCodexInactivityAbort(msg);
            const failure = describeCodexFailure(msg);
            if (inactivityNotice) {
                // Our own watchdog force-stopped a hung turn: without this the turn
                // ends silently and the user never learns why nothing came back.
                // Keep the provider error visible when the event carries both.
                const message = failure ? `${inactivityNotice} Provider error: ${failure}` : inactivityNotice;
                messageBuffer.addMessage(message, 'status');
                session.sendSessionEvent({ type: 'message', message });
            } else if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_message_delta' && msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            // The state object is rebuilt per call, so the correlation fields are carried in and
            // read back out rather than living on it.
            const turnState = {
                currentTurnId,
                currentProviderTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                pendingRequestId: codexPendingRequestId,
                currentRequestId: codexCurrentRequestId,
                providerTurnToProtocol: codexProviderTurnToProtocol,
            };
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, turnState);
            codexPendingRequestId = turnState.pendingRequestId ?? null;
            codexCurrentRequestId = turnState.currentRequestId ?? null;
            currentTurnId = mapped.currentTurnId;
            currentProviderTurnId = mapped.currentProviderTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    const previousBackgroundTasks = session.getMetadata()?.codexBackgroundTasks;
    if (previousBackgroundTasks?.length) client.restoreBackgroundTasks(previousBackgroundTasks);

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session, {
        exitAfterFirstTurn,
        browserHostContinues: process.env.HAPPY_AUTOMATION_BROWSER_CONTINUATION === '1',
        ...(runtimeGate ? { admitTool: <T,>(work: () => Promise<T>) => runtimeGate.admit(work, 'writer') } : {}),
        ...(accountToken !== null ? { proposeLesson: lessonProposalTurn.submit } : {}),
        checkpointReader: checkpointComposition.agentReader,
        protectedBashCwd: checkpointComposition.protectedBashCwd,
        trackProtectedBashProcess: checkpointComposition.trackProtectedWriter,
    });
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    // Account-only: the aplus MCP config belongs to a user, and a managed run
    // has none. Skipped rather than attempted with a scoped bearer.
    const initialAplusMcpSnapshot = accountToken === null ? null : await fetchAplusMcpConfigSnapshot(
        accountToken,
        requireAccountMachineId(machineId),
        { sessionId: session.sessionId },
    );
    const initialAplusMcpResult = initialAplusMcpSnapshot?.result ?? null;
    let configStatuses = initialAplusMcpResult ? mcpConfigFailureStatuses(initialAplusMcpResult) : [];
    const initialAplusMcpServers = initialAplusMcpSnapshot?.servers ?? {};
    const initialMcpCheckedAt = Date.now();
    session.updateMetadata((current) => ({
        ...current,
        mcpServers: [
            ...Object.keys(initialAplusMcpServers)
                .filter((name) => !configStatuses.some((entry) => entry.name === name))
                .map((name) => ({ name, status: 'reconnecting' as const, checkedAt: initialMcpCheckedAt })),
            ...configStatuses,
        ],
    }));
    const baseMcpServers = {
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url]
        }
    };
    const bridgeOptions = { bridgeCommand: bridgeEntrypoint, nodeExecPath: process.execPath };
    const listExternalServices = (mcpServers: Record<string, unknown>) => listExpectedMcpServices({
        expectedConnectors: readExpectedConnectors(),
        expectedMcpServices: readExpectedMcpServices(),
        configuredServerNames: Object.keys(mcpServers),
    });
    const listConfiguredExternalServices = (mcpServers: Record<string, unknown>) => listExpectedMcpServices({
        expectedConnectors: [],
        expectedMcpServices: [],
        configuredServerNames: Object.keys(mcpServers),
    });
    const buildConnectorGuidance = (mcpServers: Record<string, unknown>) => buildConnectorToolGuidance(
        listExternalServices(mcpServers),
        { connectorPlatformConfigured: isConnectorPlatformConfigured() },
    );
    let currentDeveloperInstructions: string | undefined = buildConnectorGuidance({
        ...baseMcpServers,
        ...initialAplusMcpServers,
    });
    const mcpConfigSynchronizer = new CodexMcpConfigSynchronizer({
        baseServers: baseMcpServers,
        initialAplusServers: initialAplusMcpServers,
        floorServerNames: resolveMcpFloorServerNames(initialAplusMcpServers, readExpectedConnectors()),
        fetchAplusServers: async () => {
            // 조회 직전에 교환해야 새 grant 로 조회된다. 24시간을 넘겨 사는
            // 세션이 403 으로 마지막 정상 설정에 갇히는 것을 막는다.
            const account = requireAccountMachineId(machineId);
            await refreshMcpCallerGrantIfExpiring(requireAccountToken(accountToken), account, { sessionId: readLessonOwner() === 'host' ? session.sessionId : undefined });
            const result = await fetchAplusMcpServersResult(
                requireAccountToken(accountToken),
                account,
                { sessionId: session.sessionId, lifecycle: 'turn' },
            );
            configStatuses = mcpConfigFailureStatuses(result);
            return result;
        },
        bridgeAplusServers: (servers) => bridgeAplusMcpServers(servers, bridgeOptions),
        onStatus: (status) => {
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                mcpServers: [
                    ...(currentMetadata.mcpServers ?? []).filter((server) => server.name !== status.name),
                    status,
                ],
            }));
        },
    });
    const mcpRuntimeRecovery = new CodexMcpRuntimeRecovery(client);
    const reportMcpStatuses = async (inspectedStatuses?: McpRuntimeServerStatus[]) => {
        const threadId = client.threadId;
        if (!threadId) return [];
        // Reporting status is informational. It runs on the turn path, where a
        // rejection would land in the turn's catch, be reported to the user as
        // 'Process exited unexpectedly' and silently discard their prompt -- so
        // an unknown status degrades to no update, never to a lost turn.
        let runtimeStatuses;
        try {
            runtimeStatuses = inspectedStatuses ?? await mcpRuntimeRecovery.readStatuses({
                threadId,
                mcpServers: mcpConfigSynchronizer.mcpServers,
                expectedServerNames: listConfiguredExternalServices(mcpConfigSynchronizer.mcpServers),
            });
        } catch (error) {
            logger.debug('[codex]: MCP status probe failed, leaving statuses unchanged', error);
            return [];
        }
        const statuses = [
            ...runtimeStatuses.filter((entry) => !configStatuses.some(({ name }) => name === entry.name)),
            ...configStatuses,
        ];
        session.updateMetadata((current) => ({ ...current, mcpServers: statuses }));
        return statuses;
    };
    session.rpcHandlerManager.registerHandler('mcp-status', async (params: { sessionId?: string }) => {
        if (params.sessionId !== session.sessionId) throw new Error('Session mismatch');
        if (runtimeGate?.isClosed()) return { statuses: session.getMetadata()?.mcpServers ?? [] };
        return { statuses: await (runtimeGate ? runtimeGate.admit(reportMcpStatuses, 'writer') : reportMcpStatuses()) };
    });

    let appendSystemPromptInjected = false;
    // Assigned inside the `try` once the loop's stop gate exists; called from
    // its `finally`. Until then there is no stop to report.
    let reportManagedStop: () => Promise<void> = async () => undefined;

    try {
        logger.debug('[codex]: client.connect begin');
        try {
            await client.connect();
            logger.debug('[codex]: client.connect done');

            if (opts.resumeThreadId) {
                await resumeExistingThread({
                    client,
                    session,
                    messageBuffer,
                    threadId: opts.resumeThreadId,
                    cwd: process.cwd(),
                    mcpServers: mcpConfigSynchronizer.mcpServers,
                    developerInstructions: currentDeveloperInstructions,
                });
                await reportMcpStatuses();
                appendSystemPromptInjected = true;
            }
        } catch (error) {
            // The daemon spawns this process with stdio ignored, so the caller's
            // stderr report reaches no one. Record the reason here; the finally
            // below flushes it before the session is closed.
            logger.warn('[codex]: Codex failed to start', error);
            const failureMessage = `Codex failed to start: ${error instanceof Error ? error.message : String(error)}`;
            messageBuffer.addMessage(failureMessage, 'status');
            session.sendSessionEvent({ type: 'message', message: failureMessage });
            throw error;
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            try {
                const { thread } = await client.readThread({
                    threadId: forkCodexThreadId,
                    includeTurns: true,
                });
                const envelopes = await buildCodexThreadBackfillEnvelopes({
                    thread,
                    uploadLocalImage: (attachment, imageOpts) => (
                        session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                    ),
                });
                for (const envelope of envelopes) {
                    session.sendSessionProtocolMessage(envelope);
                }
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: forkCodexThreadId,
                }));
                logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
            } catch (error) {
                logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
            }
        }


        /*
         * A managed Codex run can be asked to end its input without being
         * killed. Same contract as the Claude path: the queue is only closed
         * when nothing is queued and nothing is held back for the next turn.
         */
        const gracefulStop = managedStartup
            ? createManagedGracefulStop({
                queueSize: () => messageQueue.size(),
                hasPending: () => pending !== null,
                wake: () => { messageQueue.close(); },
            })
            : null;
        registerManagedGracefulStop(gracefulStop);
        /*
         * Codex runs one app server for the whole session, so its generation
         * record is a single one — but it is still a record beside the thing
         * it describes, not a flag on the stop.
         */
        const codexProof = { inputExhausted: false };
        /**
         * The verdict for this run, reported once, for a run that was asked
         * to stop — from the loop's `finally`, so a loop that leaves by any
         * route (an abort, a run-once turn, a throw) still answers the stop
         * it was asked for rather than leaving the supervisor to its budget.
         */
        reportManagedStop = async (): Promise<void> => {
            if (!gracefulStop?.requested()) return;
            if (!codexProof.inputExhausted) {
                reportManagedStopOutcome('input-not-exhausted');
                return;
            }
            /*
             * No signal. `disconnect()` does `stdin.end()` and `SIGTERM` in one
             * breath and never awaits the exit, so it can never prove a flush;
             * this ends stdin and waits for what the kernel actually says.
             */
            const left = await client.endInputAndAwaitExit(CODEX_END_INPUT_BUDGET_MS);
            reportManagedStopOutcome(
                left.exited && left.code === 0 && left.signal === null
                    ? MANAGED_STOP_CLEAN
                    : 'provider-exit-unclean',
            );
        };

        if (standaloneLaunch) {
            if (!runtimeGate) throw new Error('Standalone runtime storage gate unavailable');
            const provider = scopeLaunch ? {
                freezeInputForShutdown: () => !thinking && !pending && messageQueue.size() === 0 && client.freezeInputForShutdown(),
                interruptTurn: () => client.interruptTurn(),
                endInputAndAwaitExit: (budget: number, signal?: AbortSignal) => client.endInputAndAwaitExit(budget, signal),
                waitForOutputDrain: () => client.waitForOutputDrain(), cancelOutputDrain: () => client.cancelOutputDrain(),
                finishShutdownObservation: () => client.finishShutdownObservation(),
            } : client;
            const storage = scopeLaunch ? {
                tracksShutdownStorage: session.tracksShutdownStorage,
                flushForShutdown: async (budget: number, signal?: AbortSignal) => {
                    const proof = await session.flushForShutdown(budget, signal);
                    return proof.stored && !await session.confirmShutdownCursor()
                        ? { stored: false as const, reason: 'unconfirmed-write' as const } : proof;
                },
                isStorageConfirmationCurrent: (proof: Parameters<typeof session.isStorageConfirmationCurrent>[0]) => session.isStorageConfirmationCurrent(proof),
            } : session;
            launchControl!.bind(provider, storage, runtimeGate);
        }

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: CollectedBatch<EnhancedMode> | null = pending;
            if (message && runtimeGate && !runtimeGate.tryBeginPreparing()) break;
            pending = null;
            if (!message) {
                /*
                 * The turn boundary. A stop asked for mid-turn lands here,
                 * with the turn finished and nothing accepted after it.
                 */
                if (gracefulStop?.mayEndInput()) {
                    codexProof.inputExhausted = true;
                    shouldExit = true;
                    break;
                }
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal, runtimeGate ? () => runtimeGate.tryBeginPreparing() : undefined);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    /*
                     * Woken by the stop rather than aborted. The abort check is
                     * the point: a run aborted while a stop happened to be
                     * pending did not exhaust its input — and neither did one
                     * whose queue was closed by something else while work was
                     * still queued or held back, which is what `mayEndInput`
                     * rules out.
                     */
                    if (gracefulStop?.mayEndInput() && !waitSignal.aborted) {
                        codexProof.inputExhausted = true;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            /*
             * Set here, after `message` has been resolved from *either* the deferred `pending`
             * slot or a fresh batch, so a deferred channel turn keeps its handle and an ordinary
             * turn clears it rather than inheriting the previous one. Assigning it in the wait
             * branch alone would miss the deferred path, which is the one an isolated channel
             * turn actually takes.
             */
            codexPendingRequestId = message.channelRequestId ?? null;
            const latency = createCodexTurnLatency(message, diagnostic => session.sendTurnLatency(diagnostic));
            activeLatency = latency;
            const measure = <T>(stage: CodexLatencyStage, action: () => T | Promise<T>): T | Promise<T> =>
                latency ? latency.measure(stage, action) : action();

            try {
                /*
                 * Relayed channel text is never read as session control. This is a *second* parser,
                 * on the consumer side: a channel turn reaches the queue through the session's own
                 * RPC and never passes the enqueue handler, but it does arrive here — where `/clear`
                 * wipes the Codex thread state. Gating only the enqueue side would leave an external
                 * sender able to reset a session's context (Saycode specs/desktop-messenger-channels).
                 */
                preemptLessonReview();
                lessonReviewAbort = new AbortController();
                const owningReviewSignal = lessonReviewAbort.signal;
                const owningForegroundSignal = abortController.signal;

                await measure('auth', () => authRecovery.beginTurn());
                if (shouldExit) { authRecovery.endTurn(); break; }
                if (shouldHandleCodexClear(message) && authRecovery.status().state !== 'failed') {
                    latency?.finish('control');
                    authRecovery.endTurn();
                    logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                    /*
                     * The provider's context really is being reset here, so this is
                     * where the routing epoch ends — not where /clear was accepted.
                     * Turns accepted in between still run and keep their receipts.
                     */
                    difficultyRoutingCommitter.startEpoch();
                    client.clearThreadState();
                    currentTurnId = null;
                    currentProviderTurnId = null;
                    codexStartedSubagents = new Set<string>();
                    codexActiveSubagents = new Set<string>();
                    codexProviderSubagentToSessionSubagent = new Map<string, string>();
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appendSystemPromptInjected = false;
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    messageBuffer.addMessage('Context was reset', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                    session.updateMetadata((currentMetadata) => {
                        const nextMetadata = { ...currentMetadata };
                        delete nextMetadata.codexThreadId;
                        return nextMetadata;
                    });
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => messageQueue.size(),
                        shouldExit,
                        sendReady,
                    });
                    continue;
                }

                // Display user messages in the UI
                if (message.message.trim().length > 0) {
                    messageBuffer.addMessage(message.message, 'user');
                }

                let routingApplied = false;
                try {
                    authRecovery.assertReady();
                    if (checkpointComposition.completeTurn) {
                        // specs/linux-checkpoint-enforcement-backend R4 — open the checkpoint turn (and
                        // materialize its workspace) before codex is wrapped and spawned. On Linux bwrap
                        // binds mount points into the writable root the moment it starts, so a workspace
                        // prepared afterwards would be materialized into a non-empty directory.
                        await measure('checkpoint', () => client.prepareProtectedTurn());
                        if (!client.isConnected) {
                            const expectedThreadId = client.threadId;
                            const resumed = await measure('thread-resume', () => client.reconnectAndResumeThread());
                            if (expectedThreadId && !resumed) {
                                throw new Error('checkpoint protection could not resume the Codex thread');
                            }
                        }
                    } else if (checkpointComposition.localHistory) {
                        // specs/checkpoint-local-history — the record is the dispatch gate; Codex keeps running.
                        await measure('checkpoint', () => checkpointComposition.localHistory!.beforeTurn());
                    }
                    // Map permission mode to approval policy and sandbox.
                    // With app-server, these are per-turn — no restart needed on mode change.
                    const sandboxManagedByHappy = client.sandboxEnabled;
                    const executionPolicy = resolveCodexExecutionPolicy(
                        message.mode.permissionMode,
                        sandboxManagedByHappy,
                    );

                    // 샌드박스 초기화가 실패했고, 이 턴의 모드가 하필 네트워크를 잃는
                    // 네이티브 정책으로 떨어지는 경우다. 조용히 돌면 몇 분 뒤 턴 안의
                    // 네트워크 호출이 DNS 에서 실패할 때가 돼서야 드러난다 — 그 자리에서
                    // 사유를 밝히고 턴을 멈춘다. 네트워크가 남는 모드는 그대로 진행한다.
                    if (
                        client.sandboxInitFailed
                        && isSandboxFallbackNetworkLoss(sandboxConfig, executionPolicy.sandbox)
                    ) {
                        const notice = `Sandbox initialization failed, so permission mode `
                            + `'${message.mode.permissionMode}' falls back to Codex's native read-only `
                            + `policy, which has no network access at all — but this session requested `
                            + `network (networkMode=${sandboxConfig?.networkMode}). Refusing to run the `
                            + `turn without it. Original error: ${client.sandboxInitFailureReason}`;
                        logger.warn(`[Codex] ${notice}`);
                        messageBuffer.addMessage(notice, 'status');
                        session.sendSessionEvent({ type: 'message', message: notice });
                        continue;
                    }

                    const checkpointGuidance = await checkpointComposition.agentReader?.guidance();
                    const mcpSync = await measure('mcp-sync', () => mcpConfigSynchronizer.sync({
                        threadId: client.threadId,
                        resumeThread: client.threadId
                            ? async ({ threadId, mcpServers }) => {
                                const nextDeveloperInstructions = buildCodexDeveloperInstructions({
                                    connectorGuidance: buildConnectorGuidance(mcpServers),
                                    checkpointGuidance,
                                    agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
                                    mode: message.mode,
                                });
                                const resumed = await client.resumeThread({
                                    threadId,
                                    writableRoots: additionalDirectories,
                                    mcpServers,
                                    developerInstructions: nextDeveloperInstructions ?? null,
                                });
                                currentDeveloperInstructions = nextDeveloperInstructions;
                                return resumed;
                            }
                            : undefined,
                    }));

                    const nextDeveloperInstructions = buildCodexDeveloperInstructions({
                        connectorGuidance: buildConnectorGuidance(mcpSync.mcpServers),
                        checkpointGuidance,
                        agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
                        mode: message.mode,
                    });
                    if (client.threadId && nextDeveloperInstructions !== currentDeveloperInstructions) {
                        const threadId = client.threadId;
                        await measure('thread-resume', () => client.resumeThread({
                            threadId,
                            writableRoots: additionalDirectories,
                            mcpServers: mcpSync.mcpServers,
                            developerInstructions: nextDeveloperInstructions ?? null,
                        }));
                        currentDeveloperInstructions = nextDeveloperInstructions;
                    }

                    // Start thread on first turn (thread persists across mode changes)
                    let activeThreadId = client.threadId;
                    const recallResumedThread = Boolean(activeThreadId);
                    if (!client.hasActiveThread() || !activeThreadId) {
                        const startedThread = await measure('thread-start', () => client.startThread({
                            model: message.mode.model,
                            cwd: process.cwd(),
                            approvalPolicy: executionPolicy.approvalPolicy,
                            sandbox: executionPolicy.sandbox,
                            writableRoots: additionalDirectories,
                            mcpServers: mcpSync.mcpServers,
                            developerInstructions: nextDeveloperInstructions,
                        }));
                        activeThreadId = startedThread.threadId;
                        currentDeveloperInstructions = nextDeveloperInstructions;
                        session.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            codexThreadId: startedThread.threadId,
                        }));
                    }

                    const runtimeRecovery = await measure('mcp-recovery', () => mcpRuntimeRecovery.recoverBeforeTurn({
                        threadId: activeThreadId,
                        mcpServers: mcpSync.mcpServers,
                        expectedServerNames: listConfiguredExternalServices(mcpSync.mcpServers),
                        developerInstructions: currentDeveloperInstructions,
                        includeRuntimeStatuses: true,
                        measure: latency ? measure : undefined,
                    }));
                    await measure('mcp-status', () => reportMcpStatuses(runtimeRecovery.runtimeStatuses));
                    if (runtimeRecovery.status !== 'ready') {
                        const metadataStatuses = buildCodexMcpRecoveryMetadataStatuses({
                            recovery: runtimeRecovery,
                            connectorNames: readExpectedConnectors(),
                            checkedAt: Date.now(),
                        });
                        for (const metadataStatus of metadataStatuses) {
                            session.updateMetadata((currentMetadata) => ({
                                ...currentMetadata,
                                mcpServers: [
                                    ...(currentMetadata.mcpServers ?? []).filter(
                                        (server) => server.name !== metadataStatus.name,
                                    ),
                                    metadataStatus,
                                ],
                            }));
                        }
                    }

                    const goalCommand = parseCodexGoalCommand(message.message);
                    if (goalCommand && await handleCodexGoalCommand(goalCommand, activeThreadId)) {
                        latency?.finish('control');
                        continue;
                    }

                    const includeAppendSystemPrompt = Boolean(
                        message.mode.saycodeSystemPromptEnabled === undefined
                        && message.mode.appendSystemPrompt
                        && !appendSystemPromptInjected,
                    );
                    const imageInputs = await measure('images', () => prepareCodexImageInputItems(message.attachments, {
                        sessionId: session.sessionId,
                    }));
                    if ((message.attachments?.length ?? 0) > 0) {
                        logger.debug('[Codex] Prepared image inputs for turn', {
                            inputCount: imageInputs.inputItems.length,
                            skippedCount: imageInputs.skipped,
                        });
                    }
                    const hasUserText = message.message.trim().length > 0;
                    if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                        session.sendSessionEvent({
                            type: 'message',
                            message: 'No supported images were available to send to Codex.',
                        });
                        continue;
                    }
                    /*
                     * Lessons are recalled here, immediately before the input is
                     * assembled, and on a bounded budget: a slow or unreachable
                     * memory service costs this turn nothing. The review signal
                     * stops memory work when a new message arrives without
                     * aborting the provider's foreground turn.
                     */
                    lessonProposalTurn.cancel();
                    codexTurnId = `${session.sessionId}:${randomUUID()}`;
                    const lessonFrame = {
                        turnId: codexTurnId, userMessages: [message.message],
                        controller: lessonReviewAbort, acceptingSteer: false, pendingSteer: false,
                    };
                    activeLessonTurn = lessonFrame;
                    const lessonRecall = lessonTurn
                        ? await measure('lesson-recall', () => lessonTurn.recall({
                            turnId: codexTurnId,
                            query: message.message,
                            signal: owningReviewSignal,
                        }))
                        : null;
                    let reviewInstruction = lessonSessionKind === 'foreground' && !owningReviewSignal.aborted && lessonReview?.prepareReviewTurn
                        ? await measure('lesson-proposal', () => lessonProposalTurn.prepare(codexTurnId!, () => lessonReview.prepareReviewTurn!())) : '';
                    if (owningForegroundSignal.aborted) { lessonProposalTurn.cancel(); continue; }
                    if (owningReviewSignal.aborted) { lessonProposalTurn.cancel(); reviewInstruction = ''; }
                    // Resolve the channel permit before running stateful event-memory hooks.
                    // Requests rejected here must not advance adherence or record recall.
                    if (message.channelRequestId !== undefined
                        && !await channelAcceptance.prepareExecution(message.channelRequestId)) {
                        codexPendingRequestId = null;
                        lessonProposalTurn.cancel();
                        continue;
                    }
                    // Approval awaited: foreground cancellation must be checked again before
                    // running the host worker.
                    if (owningForegroundSignal.aborted) { lessonProposalTurn.cancel(); continue; }
                    const memoryRecall = recallHost
                        ? await recallHost.recall({
                            threadId: activeThreadId,
                            prompt: message.message,
                            resumed: recallResumedThread,
                            signal: owningForegroundSignal,
                        })
                        : null;
                    // A dispatched host worker can still be aborted. Do not send the provider
                    // a cancelled turn or consume its pending startup context in that case.
                    if (owningForegroundSignal.aborted) { lessonProposalTurn.cancel(); continue; }
                    if (owningReviewSignal.aborted) { lessonProposalTurn.cancel(); reviewInstruction = ''; }
                    const turnPrompt = (reviewInstruction ? `${reviewInstruction}\n\n` : '') + buildCodexTurnPrompt({
                        message: message.message,
                        mode: message.mode,
                        includeAppendSystemPrompt,
                        hasTitle: titleCoveredForTurn({
                            hasTitle: session.hasTitle(),
                            job: offTurnTitle,
                            eligible: isOffTurnTitleEligible({
                                sideCommandAllowed: client.sideCommandAllowed,
                                exitAfterFirstTurn,
                            }),
                            message: message.message,
                            model: message.mode.model,
                        }),
                        ...(lessonRecall?.outcome === 'selected' ? { lessonBlock: lessonRecall.block } : {}),
                        ...(memoryRecall?.reason === 'context_returned' ? { memoryBlock: buildCodexMemoryReferenceBlock(memoryRecall.context) } : {}),
                    });
                    // The worker awaited after the permit was granted. Keep consumption at
                    // the synchronous dispatch boundary so channel cancellation still wins.
                    if (message.channelRequestId !== undefined
                        && !channelAcceptance.beginExecution(message.channelRequestId)) {
                        codexPendingRequestId = null;
                        lessonProposalTurn.cancel();
                        continue;
                    }
                    lessonFrame.acceptingSteer = true;
                    /*
                     * The engine-applied boundary: this batch's model and effort are
                     * about to become the turn's settings. Everything before this
                     * point — classification, acceptance, queueing — could still have
                     * been cancelled without the conversation ever running on the
                     * routed model, which is why the floor waits until here.
                     *
                     * Committed *before* the await, not after: the settings are
                     * applied by the call itself, so a turn that then fails or is
                     * cancelled mid-flight still ran on this model.
                     */
                    const appliedRoute = difficultyRoutingCommitter.commitApplied(message.requestIds, codexTurnId!);
                    routingApplied = true;
                    latency?.submitted();
                    const memoryIngest = reserveCompletedTurnIngest(activeThreadId);
                    const result = await client.sendTurnAndWait(turnPrompt, {
                        ...(memoryRecall?.reason === 'context_returned' ? { onSubmitted: () => recallHost?.markSubmitted(activeThreadId, memoryRecall.startupIncluded === true) } : {}),
                        ...(memoryIngest ? { onCompleted: memoryIngest.onCompleted,
                            onCompletionObservationSettled: memoryIngest.onSettled } : {}),
                        model: appliedRoute ? appliedRoute.model : message.mode.model,
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        writableRoots: additionalDirectories,
                        effort: appliedRoute
                            ? (isSupportedCodexReasoningEffort(appliedRoute.effort) ? appliedRoute.effort : undefined)
                            : message.mode.effort,
                        extraInputItems: imageInputs.inputItems,
                    }).catch(error => { memoryIngest?.onSettled(); throw error; }).finally(async () => {
                        // Recorded even after a failed turn: it may already have changed files. A
                        // missing record only makes a later restore more cautious.
                        await checkpointComposition.localHistory?.afterTurn().catch((error) => {
                            logger.debug('[Codex] local history record after turn failed', error);
                        });
                    });
                    latency?.finish(result.aborted ? 'cancelled' : 'completed');
                    lessonFrame.acceptingSteer = false;
                    if (lessonFrame.pendingSteer) preemptLessonReview();
                    if (includeAppendSystemPrompt) {
                        appendSystemPromptInjected = true;
                    }

                    if (result.aborted) {
                        // Turn was aborted (user abort or permission cancel).
                        // UI handling already done by the event handler (turn_aborted).
                        logger.debug('[Codex] Turn aborted');
                        memoryIngest?.onSettled();
                    }

                    if (lessonTurn && lessonRecall?.outcome === 'selected' && !result.aborted) {
                        /*
                         * The acknowledgement, and only now. `sendTurnAndWait`
                         * resolving without an abort is the first point at which
                         * the provider is known to have taken this input —
                         * assembling the prompt was not, and neither was sending
                         * it. Recording delivery earlier would claim a delivery
                         * that an abort could still have prevented.
                         *
                         * Its own catch: a memory failure must not fall into the
                         * turn's error handler, which closes the turn as aborted
                         * and writes a failure into the transcript.
                         */
                        await lessonTurn.acknowledge(lessonRecall.ticket).catch(() => false);
                    }
                    if (result.aborted) preemptLessonReview();
                    if (lessonReview && !result.aborted) {
                        const observed = codexTurnObservations.take();
                        /*
                         * A normally-ended turn, with what this host actually saw
                         * of it. The worker validates this turn's proposal against
                         * its evidence, permissions and settings. Not awaited:
                         * candidate persistence never blocks the chat, and the
                         * same abort signal stops it when the user speaks again.
                         */
                        const reviewWork = () => lessonReview.reviewFinishedTurn({
                            ...lessonProposalTurn.take(codexTurnId),
                            record: {
                                sessionId: session.sessionId,
                                turnId: codexTurnId,
                                // The real kind of this turn. Hard-coding
                                // `foreground` would let automation and review
                                // turns teach the project.
                                kind: lessonSessionKind,
                                endedNormally: true,
                                hadPriorAssistantTurn: codexTurnCounter > 0,
                                userMessages: [...lessonFrame.userMessages],
                                agentSummary: observed.summary,
                                recoveredFailures: observed.recoveredFailures,
                            },
                            signal: lessonFrame.controller.signal,
                        });
                        // Review is optional: after shutdown freeze no new candidate job may start.
                        void (runtimeGate ? runtimeGate.admit(reviewWork, 'writer') : reviewWork()).catch(() => undefined);
                    }
                    codexTurnCounter += 1;
                } catch (error) {
                    latency?.finish('failed');
                    preemptLessonReview();
                    // Only actual errors reach here (process crash, connection failure, etc.)
                    // No task_complete/turn_aborted was ever received for this turn, so the
                    // session-protocol mapper's turn state is left open. Without an explicit
                    // close here, the durable transcript keeps an unclosed turn forever (the
                    // 'thinking' ephemeral below still gets set false, but that is live-only
                    // and does not repair what a reload/observer reads from history), and the
                    // dangling currentTurnId would make the mapper treat the NEXT task_started
                    // as a nested continuation (task_started no-ops while currentTurnId is set),
                    // silently dropping turn-start too. Synthesize the same close the mapper
                    // would have produced from a real turn_aborted, reusing its guard logic
                    // (harmless no-op if currentTurnId is already null).
                    logger.warn('Error in codex session:', error);
                    const failureMessage = describeCheckpointFailure(error) ?? 'Process exited unexpectedly';
                    messageBuffer.addMessage(failureMessage, 'status');
                    session.sendSessionEvent({ type: 'message', message: failureMessage });
                    // Carries the correlation in and reads it back, like the normal event path. A
                    // dispatch or process failure is still the answer to whatever request was waiting
                    // on it; a fresh state object here would drop the id and leave the caller waiting.
                    const failureState: CodexTurnState = {
                        currentTurnId,
                        currentProviderTurnId,
                        startedSubagents: codexStartedSubagents,
                        activeSubagents: codexActiveSubagents,
                        providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                        pendingRequestId: codexPendingRequestId,
                        currentRequestId: codexCurrentRequestId,
                        providerTurnToProtocol: codexProviderTurnToProtocol,
                    };
                    const closed = mapCodexMcpMessageToSessionEnvelopes(
                        { type: 'turn_aborted', status: 'failed' },
                        failureState,
                    );
                    codexPendingRequestId = failureState.pendingRequestId ?? null;
                    codexCurrentRequestId = failureState.currentRequestId ?? null;
                    currentTurnId = closed.currentTurnId;
                    currentProviderTurnId = closed.currentProviderTurnId;
                    codexStartedSubagents = closed.startedSubagents;
                    codexActiveSubagents = closed.activeSubagents;
                    codexProviderSubagentToSessionSubagent = closed.providerSubagentToSessionSubagent;
                    for (const envelope of closed.envelopes) {
                        session.sendSessionProtocolMessage(envelope);
                    }
                } finally {
                    if (!routingApplied) {
                        difficultyRoutingCommitter.discardPending(message.requestIds ?? [], owningForegroundSignal.aborted ? 'cancelled' : 'failed');
                    }
                    activeLessonTurn = null;
                    lessonProposalTurn.cancel();
                    // specs/linux-checkpoint-enforcement-backend R4 — the checkpoint turn is opened before
                    // codex is spawned, so a message that never reached completeTurn (refused turn, resume
                    // failure, thrown dispatch) would otherwise leave the turn open and block the next gate.
                    // abortTurn() no-ops after a completed turn.
                    client.abortPreparedTurn();
                    try {
                        await checkpointComposition.abortTurn?.();
                    } catch (error) {
                        logger.debug('[codex]: checkpoint abortTurn failed', error);
                    }
                    authRecovery.endTurn();
                    // Reset permission handler, reasoning processor, and diff processor
                    permissionHandler.reset();
                    reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                    diffProcessor.reset();
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => messageQueue.size(),
                        shouldExit,
                        sendReady,
                    });
                    if (exitAfterFirstTurn) {
                        logger.debug('[codex]: Automation turn completed, exiting run-once session');
                        shouldExit = true;
                    }
                    // Clear after checkpoint cleanup: it may finish pending command events.
                    // Aborted/failed turns must not teach a recovery in the next turn.
                    codexTurnObservations.take();
                    logActiveHandles('after-turn');
                }
            } finally {
                latency?.finish(abortController.signal.aborted ? 'cancelled' : 'failed');
                if (activeLatency === latency) activeLatency = null;
                runtimeGate?.endTurn();
            }
        }

    } finally {
        let loopExitRecorded = false;
        try {
            preemptLessonReview();
            const frozen = runtimeGate?.isFrozen() === true;
            if (frozen) {
                // Optional memory is outside the foreground drain contract. Stop its
                // pending metadata reads and kill/join its worker before exposing the
                // frozen runtime to SessionDrain's deadline.
                cancelMemoryIngest();
                await closeMemoryIngest();
            }
            if (runtimeGate) {
                // Seal synchronously before stopping the listener; existing callbacks retain their promises.
                const producers = runtimeGate.closeAdmissionAndWait();
                happyServer.stop();
                if (runtimeGate.isFrozen()) {
                    // The coordinator still owns provider EOF and storage proof.
                    // The loop has finished its writes; the gate still tracks
                    // admitted writers separately. A blocked decision must be
                    // handled even when one of those writers never settles.
                    runtimeGate.loopExited();
                    loopExitRecorded = true;
                    const decision = await runtimeGate.waitForShutdownDecision();
                    if (decision === 'blocked') {
                        clearInterval(keepAliveInterval);
                        process.exitCode = 1;
                        if (process.stdin.isTTY) {
                            try { process.stdin.setRawMode(false); } catch { }
                        }
                        logger.warn('[Codex] Shutdown blocked; retaining API and provider ownership');
                        await new Promise<never>(() => {});
                    }
                }
                await producers;
            }
            // Run-once sessions need the same durable completion as long-lived sessions;
            // do not cancel their just-enqueued import merely because the loop ended.
            await Promise.all([...pendingMemoryIngest]);
            await closeMemoryIngest();
            await reportManagedStop();
            /*
             * The bridge points at this run's loop. Left registered, a stop
             * arriving later would be applied to a loop that has ended, or handed
             * to the next run, which nobody asked to stop.
             */
            registerManagedGracefulStop(null);
            // Clean up resources when main loop exits
            logger.debug('[codex]: Final cleanup start');
            logActiveHandles('cleanup-start');

            // Cancel offline reconnection if still running
            if (reconnectionHandle) {
                logger.debug('[codex]: Cancelling offline reconnection');
                reconnectionHandle.cancel();
            }

            try {
                logger.debug('[codex]: sendSessionDeath');
                session.sendSessionDeath();
                logger.debug('[codex]: flush begin');
                await session.flush();
                logger.debug('[codex]: flush done');
                logger.debug('[codex]: session.close begin');
                await session.close();
                logger.debug('[codex]: session.close done');
            } catch (e) {
                logger.debug('[codex]: Error while closing session', e);
            }
            logger.debug('[codex]: client.disconnect begin');
            offTurnTitle.cancel();
            await client.disconnect();
            // Closes the project store this session opened. Its own catch: memory
            // cleanup must not be the thing that fails a shutdown.
            await lessonSession?.close().catch(() => undefined);
            await checkpointComposition.dispose?.();
            logger.debug('[codex]: client.disconnect done');
            // Stop Happy MCP server
            logger.debug('[codex]: happyServer.stop');
            if (!runtimeGate) happyServer.stop();

            // Clean up ink UI
            if (process.stdin.isTTY) {
                logger.debug('[codex]: setRawMode(false)');
                try { process.stdin.setRawMode(false); } catch { }
            }
            // Stop reading from stdin so the process can exit
            if (hasTTY) {
                logger.debug('[codex]: stdin.pause()');
                try { process.stdin.pause(); } catch { }
            }
            // Clear periodic keep-alive to avoid keeping event loop alive
            logger.debug('[codex]: clearInterval(keepAlive)');
            clearInterval(keepAliveInterval);
            if (inkInstance) {
                logger.debug('[codex]: inkInstance.unmount()');
                inkInstance.unmount();
            }
            messageBuffer.clear();

            logActiveHandles('cleanup-end');
            logger.debug('[codex]: Final cleanup completed');
        } finally {
            clearInterval(keepAliveInterval);
            if (!loopExitRecorded) runtimeGate?.loopExited();
        }
    }
    } finally {
        launchControl?.close();
    }
}

import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { SyncBridge } from '@/api/syncBridge';
import { resolveSessionScopedSyncNodeToken } from '@/api/syncNodeToken';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
import { CodexAppServerClient } from './codexAppServerClient';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import {
    handleCodexEvent,
    flushV3CodexTurn,
    createV3CodexMapperState,
    type V3CodexMapperState,
} from './utils/v3Mapper';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { resumeExistingThread } from './resumeExistingThread';
import type { v3 } from '@slopus/happy-sync';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
}): Promise<void> {
    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
        }
    });
    session = initialSession;

    // ─── Create SyncBridge directly (no routing through ApiSessionClient) ────
    const workingDirectory = process.cwd();
    let syncBridge: SyncBridge | null = null;
    let rpcHandlerManager: RpcHandlerManager | null = null;

    if (response) {
        const sessionScopedToken = await resolveSessionScopedSyncNodeToken({
            serverUrl: configuration.serverUrl,
            sessionId: response.id,
            token: {
                raw: opts.credentials.token,
                claims: {
                    scope: { type: 'account', userId: 'cli' },
                    permissions: ['read', 'write', 'admin'],
                },
            },
        });

        syncBridge = new SyncBridge({
            serverUrl: configuration.serverUrl,
            token: sessionScopedToken,
            keyMaterial: {
                key: response.encryptionKey,
                variant: response.encryptionVariant,
            },
            sessionId: response.id as v3.SessionID,
        });
        await syncBridge.connect();
        logger.debug('[Codex] SyncBridge connected');

        // ─── Create RpcHandlerManager and wire to SyncBridge ────────────
        rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: response.id,
            encryptionKey: response.encryptionKey,
            encryptionVariant: response.encryptionVariant,
        });

        syncBridge.setRpcHandler(async (method: string, params: string) => {
            return rpcHandlerManager!.handleRequest({ method, params });
        });
        rpcHandlerManager.setRegistrationCallback((prefixedMethod) => {
            syncBridge!.registerRpcMethods([prefixedMethod]);
        });
        registerCommonHandlers(rpcHandlerManager, workingDirectory);
        syncBridge.registerRpcMethods(rpcHandlerManager.getRegisteredMethods());
    }

    // v3 Codex mapper state — managed directly instead of through ApiSessionClient
    let v3CodexMapperState: V3CodexMapperState | null = null;

    function publishCodexV3Message(message: v3.MessageWithParts): void {
        if (!syncBridge) return;
        // These files will be deleted in Step 6; cast to any to compile against new SessionMessage API
        syncBridge.sendMessage(message as any).catch((err) => {
            logger.debug('[Codex] SyncBridge publish failed', { error: err });
        });
    }

    /** Send a Codex event through the v3 mapper and push finalized messages via SyncBridge. */
    function sendCodexV3Event(event: Record<string, unknown>): void {
        if (!syncBridge) return;
        if (!v3CodexMapperState) {
            v3CodexMapperState = createV3CodexMapperState({
                sessionID: response!.id,
                providerID: 'openai',
            });
        }
        const result = handleCodexEvent(event, v3CodexMapperState);
        if (result.currentAssistant) {
            publishCodexV3Message(result.currentAssistant);
        }
        for (const msg of result.messages) {
            publishCodexV3Message(msg);
        }
    }

    /** Flush any in-flight v3 Codex assistant message. */
    function flushCodexV3TurnLocal(): void {
        if (!syncBridge || !v3CodexMapperState) return;
        const messages = flushV3CodexTurn(v3CodexMapperState);
        for (const msg of messages) {
            publishCodexV3Message(msg);
        }
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    if (syncBridge) {
        syncBridge.onRuntimeConfigChange((change) => {
            if (typeof change.permissionMode === 'string') {
                currentPermissionMode = change.permissionMode as import('@/api/types').PermissionMode;
            }
            if (Object.prototype.hasOwnProperty.call(change, 'model')) {
                currentModel = change.model || undefined;
            }
        });
    }

    if (syncBridge) {
        syncBridge.onUserMessage((message) => {
            // Extract text from the first text part
            const textPart = (message as any).parts.find((p: any): p is { type: 'text'; text: string } => p.type === 'text');
            if (!textPart) return;
            const text = textPart.text;

            // Extract meta from user message info if available
            const meta = (message as any).info?.role === 'user' ? (message as any).info.meta : undefined;

            // Resolve permission mode (accept all modes, will be mapped in switch statement)
            let messagePermissionMode = currentPermissionMode;
            if (meta?.permissionMode) {
                messagePermissionMode = meta.permissionMode as import('@/api/types').PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
            }

            // Resolve model; explicit null resets to default (undefined)
            let messageModel = currentModel;
            if (meta?.hasOwnProperty?.('model')) {
                messageModel = meta.model || undefined;
                currentModel = messageModel;
                logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
            } else {
                logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
            }

            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
            };
            messageQueue.push(text, enhancedMode);
        });
    } else {
        // Fallback: legacy ApiSessionClient user message path for offline mode
        session.onUserMessage((message) => {
            let messagePermissionMode = currentPermissionMode;
            if (message.meta?.permissionMode) {
                messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
                currentPermissionMode = messagePermissionMode;
            }
            let messageModel = currentModel;
            if (message.meta?.hasOwnProperty('model')) {
                messageModel = message.meta.model || undefined;
                currentModel = messageModel;
            }
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
            };
            messageQueue.push(message.content.text, enhancedMode);
        });
    }

    let thinking = false;
    const doKeepAlive = () => {
        if (syncBridge) {
            syncBridge.keepAlive(thinking, 'remote');
        } else {
            session.keepAlive(thinking, 'remote');
        }
    };
    doKeepAlive();
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(doKeepAlive, 2000);

    const sendReady = () => {
        if (syncBridge) {
            syncBridge.updateAgentState((currentState: any) => ({
                ...currentState,
                lastEvent: { type: 'ready', time: Date.now() },
            }));
        } else {
            session.sendSessionEvent({ type: 'ready' });
        }
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: response?.id ?? session.sessionId }
            );
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
    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                if (client) {
                    await client.abortTurnWithFallback();
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (syncBridge) {
                syncBridge.updateMetadata((currentMetadata: any) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                syncBridge.sendSessionDeath();
                await syncBridge.flush();
                syncBridge.disconnect();
            } else if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler — prefer SyncBridge-wired RpcHandlerManager
    const activeRpcManager = rpcHandlerManager ?? session.rpcHandlerManager;
    activeRpcManager.registerHandler('abort', handleAbort);
    syncBridge?.onAbortRequest(() => {
        void handleAbort();
    });

    registerKillSessionHandler(activeRpcManager, handleKillSession);

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

    client = new CodexAppServerClient(sandboxConfig);
    reasoningProcessor = new ReasoningProcessor((message) => {
        sendCodexV3Event(message as Record<string, unknown>);
    });
    const diffProcessor = new DiffProcessor((message) => {
        sendCodexV3Event(message as Record<string, unknown>);
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);

        if (msg.type === 'thread_started' && typeof (msg as any).thread_id === 'string') {
            const threadId = (msg as any).thread_id as string;
            if (syncBridge) {
                syncBridge.updateMetadata((currentMetadata: any) => ({
                    ...currentMetadata,
                    codexThreadId: threadId,
                }));
            } else {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: threadId,
                }));
            }
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                doKeepAlive();
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                doKeepAlive();
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

        const handledBySyntheticV3Path =
            msg.type === 'thread_started'
            || msg.type === 'token_count'
            || msg.type === 'agent_reasoning_section_break'
            || msg.type === 'agent_reasoning_delta'
            || msg.type === 'agent_reasoning'
            || msg.type === 'turn_diff';

        // Keep reasoning/diff side-channels on the v3 path only by routing the
        // synthetic processor outputs above instead of dual-writing legacy
        // session envelopes.
        if (!handledBySyntheticV3Path) {
            sendCodexV3Event(msg as Record<string, unknown>);
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const effectiveSessionId = response?.id ?? session.sessionId;
    const happyServer = await startHappyServer({ sessionId: effectiveSessionId, sendClaudeMessage: (body) => session.sendClaudeSessionMessage(body) });
    const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: bridgeCommand,
            args: ['--url', happyServer.url]
        }
    } as const;
    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        if (opts.resumeThreadId) {
            // Adapt SyncBridge or session to the ResumeThreadSession interface
            const resumeSession = {
                updateMetadata: syncBridge
                    ? (handler: (m: any) => any) => syncBridge!.updateMetadata(handler)
                    : (handler: (m: any) => any) => session.updateMetadata(handler),
                sendSessionEvent: syncBridge
                    ? (event: { type: 'message'; message: string }) => {
                        syncBridge!.updateAgentState((s: any) => ({
                            ...s,
                            lastEvent: { ...event, time: Date.now() },
                        }));
                    }
                    : (event: { type: 'message'; message: string }) => session.sendSessionEvent(event),
            };
            await resumeExistingThread({
                client,
                session: resumeSession,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers,
            });
            first = false;
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
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

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                );

                // Start thread on first turn (thread persists across mode changes)
                if (!client.hasActiveThread()) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    if (startedThread.threadId) {
                        if (syncBridge) {
                            syncBridge.updateMetadata((currentMetadata: any) => ({
                                ...currentMetadata,
                                codexThreadId: startedThread.threadId,
                            }));
                        } else {
                            session.updateMetadata((currentMetadata) => ({
                                ...currentMetadata,
                                codexThreadId: startedThread.threadId,
                            }));
                        }
                    }
                }

                const turnPrompt = first
                    ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION
                    : message.message;

                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                });
                first = false;

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                messageBuffer.addMessage('Process exited unexpectedly', 'status');
                if (syncBridge) {
                    syncBridge.updateAgentState((currentState: any) => ({
                        ...currentState,
                        lastEvent: { type: 'message', message: 'Process exited unexpectedly', time: Date.now() },
                    }));
                } else {
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Flush v3 turn before resetting processors
                flushCodexV3TurnLocal();
                // Reset reasoning processor and diff processor
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                doKeepAlive();
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            if (syncBridge) {
                logger.debug('[codex]: syncBridge.sendSessionDeath');
                syncBridge.sendSessionDeath();
                logger.debug('[codex]: syncBridge.flush begin');
                await syncBridge.flush();
                logger.debug('[codex]: syncBridge.flush done');
                logger.debug('[codex]: syncBridge.disconnect begin');
                syncBridge.disconnect();
                logger.debug('[codex]: syncBridge.disconnect done');
            } else {
                logger.debug('[codex]: sendSessionDeath');
                session.sendSessionDeath();
                logger.debug('[codex]: flush begin');
                await session.flush();
                logger.debug('[codex]: flush done');
                logger.debug('[codex]: session.close begin');
                await session.close();
                logger.debug('[codex]: session.close done');
            }
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

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
    }
}

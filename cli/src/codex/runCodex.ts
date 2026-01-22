import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { formatCodexEventForUi } from './utils/formatCodexEventForUi';
import { nextCodexLifecycleAcpMessages } from './utils/codexAcpLifecycle';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { formatErrorForUi } from "@/utils/formatErrorForUi";
import { waitForMessagesOrPending } from "@/utils/waitForMessagesOrPending";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/terminalMetadata';
import { writeTerminalAttachmentInfo } from '@/terminal/terminalAttachmentInfo';
import { buildTerminalFallbackMessage } from '@/terminal/terminalFallbackMessage';
import { readPersistedHappySession, writePersistedHappySession, updatePersistedHappySessionVendorResumeId } from "@/daemon/persistedHappySession";
import { isExperimentalCodexVendorResumeEnabled } from '@/utils/agentCapabilities';

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

export function extractCodexToolErrorText(response: CodexToolResponse): string | null {
    if (!response?.isError) {
        return null;
    }
    const text = (response.content || [])
        .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
    return text || 'Codex error';
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    terminalRuntime?: import('@/terminal/terminalRuntimeFlags').TerminalRuntimeFlags | null;
    permissionMode?: import('@/api/types').PermissionMode;
    existingSessionId?: string;
    resume?: string;
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
    // Attach to existing Happy session (inactive-session-resume) OR create a new one.
    //

    const initialPermissionMode = opts.permissionMode ?? 'default';
    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        terminalRuntime: opts.terminalRuntime ?? null,
        permissionMode: initialPermissionMode,
        permissionModeUpdatedAt: Date.now(),
    });
    const terminal = buildTerminalMetadataFromRuntimeFlags(opts.terminalRuntime ?? null);
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later after client setup)
    let permissionHandler: CodexPermissionHandler;
    // Offline reconnection handle (only relevant when creating a new session and server is unreachable)
    let reconnectionHandle: { cancel: () => void } | null = null;

    if (typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim()) {
        const existingId = opts.existingSessionId.trim();
        logger.debug(`[codex] Attaching to existing Happy session: ${existingId}`);
        const attached = await readPersistedHappySession(existingId);
        if (!attached) {
            throw new Error(`Cannot resume session ${existingId}: no local persisted session state found`);
        }
        // Ensure we have a local persisted session file for future resume.
        await writePersistedHappySession(attached);

        session = api.sessionSyncClient(attached);
        // Refresh metadata on startup (mark session active and update runtime fields).
        session.updateMetadata((currentMetadata: any) => ({
            ...currentMetadata,
            ...metadata,
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
        }));

        // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
        try {
            session.updateAgentState((currentState) => ({ ...currentState }));
        } catch (e) {
            logger.debug('[codex] Failed to prime agent state (non-fatal)', e);
        }

        // Persist terminal attachment info locally (best-effort).
        if (terminal) {
            try {
                await writeTerminalAttachmentInfo({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: existingId,
                    terminal,
                });
            } catch (error) {
                logger.debug('[START] Failed to persist terminal attachment info', error);
            }

            const fallbackMessage = buildTerminalFallbackMessage(terminal);
            if (fallbackMessage) {
                session.sendSessionEvent({ type: 'message', message: fallbackMessage });
            }
        }

        // Always report to daemon if it exists
        try {
            logger.debug(`[START] Reporting session ${existingId} to daemon`);
            const result = await notifyDaemonSessionStarted(existingId, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${existingId} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    } else {
        const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

        // Persist session for later resume (only if server responded).
        if (response) {
            await writePersistedHappySession(response);
        }

        // Handle server unreachable case - create offline stub with hot reconnection
        const offline = setupOfflineReconnection({
            api,
            sessionTag,
            metadata,
            state,
            response,
            onSessionSwap: (newSession) => {
                session = newSession;
                // Update permission handler with new session to avoid stale reference
                if (permissionHandler) {
                    permissionHandler.updateSession(newSession);
                }
            }
        });
        session = offline.session;
        reconnectionHandle = offline.reconnectionHandle;

        // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
        try {
            session.updateAgentState((currentState) => ({ ...currentState }));
        } catch (e) {
            logger.debug('[codex] Failed to prime agent state (non-fatal)', e);
        }

        // Persist terminal attachment info locally (best-effort) once we have a real session ID.
        if (response && terminal) {
            try {
                await writeTerminalAttachmentInfo({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: response.id,
                    terminal,
                });
            } catch (error) {
                logger.debug('[START] Failed to persist terminal attachment info', error);
            }

            const fallbackMessage = buildTerminalFallbackMessage(terminal);
            if (fallbackMessage) {
                session.sendSessionEvent({ type: 'message', message: fallbackMessage });
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
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        // Intentionally ignore model in the mode hash: Codex cannot reliably switch models mid-session
        // without losing in-memory context.
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = initialPermissionMode;

    session.onUserMessage((message) => {
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            session.updateMetadata((current) => ({
                ...current,
                permissionMode: currentPermissionMode,
                permissionModeUpdatedAt: Date.now(),
            }));
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Model overrides are intentionally ignored for Codex.
        // Codex's model is selected at session creation time by the Codex engine / local config.
        const messageModel: string | undefined = undefined;

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    let thinking = false;
    let currentTaskId: string | null = null;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: session.sessionId }
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

    let abortController = new AbortController();
    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;
    if (typeof opts.resume === 'string' && opts.resume.trim()) {
        storedSessionIdForResume = opts.resume.trim();
        logger.debug('[Codex] Resume requested via --resume:', storedSessionIdForResume);
    }

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Store the current session ID before aborting for potential resume
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }
            
            abortController.abort();
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
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
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.forceCloseSession();
            } catch (e) {
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
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

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

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

    const isVendorResumeRequested = typeof opts.resume === 'string' && opts.resume.trim().length > 0;
    const codexMcpServer = (() => {
        if (!isVendorResumeRequested) {
            return { mode: 'codex-cli' as const, command: 'codex' };
        }

        if (!isExperimentalCodexVendorResumeEnabled()) {
            throw new Error('Codex resume is experimental and is disabled on this machine.');
        }

        const envOverride = (() => {
            const v = typeof process.env.HAPPY_CODEX_RESUME_MCP_SERVER_BIN === 'string'
                ? process.env.HAPPY_CODEX_RESUME_MCP_SERVER_BIN.trim()
                : (typeof process.env.HAPPY_CODEX_RESUME_BIN === 'string' ? process.env.HAPPY_CODEX_RESUME_BIN.trim() : '');
            return v;
        })();
        if (envOverride && existsSync(envOverride)) {
            return { mode: 'mcp-server' as const, command: envOverride };
        }

        const binName = process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume';
        const defaultNew = join(configuration.happyHomeDir, 'tools', 'codex-mcp-resume', 'node_modules', '.bin', binName);
        const defaultOld = join(configuration.happyHomeDir, 'tools', 'codex-resume', 'node_modules', '.bin', binName);

        const found = [defaultNew, defaultOld].find((p) => existsSync(p));
        if (found) {
            return { mode: 'mcp-server' as const, command: found };
        }

        throw new Error(
            `Codex resume MCP server is not installed.\n` +
            `Install it from the Happy app (Machine details → Codex resume), or set HAPPY_CODEX_RESUME_MCP_SERVER_BIN.\n` +
            `Expected: ${defaultNew}`,
        );
    })();

    const client = new CodexMcpClient({ mode: codexMcpServer.mode, command: codexMcpServer.command });

    // NOTE: Codex resume support varies by build; forks may seed `codex-reply` with a stored session id.
    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);

    function forwardCodexStatusToUi(messageText: string): void {
        messageBuffer.addMessage(messageText, 'status');
        session.sendSessionEvent({ type: 'message', message: messageText });
    }

    function forwardCodexErrorToUi(errorText: string): void {
        const text = typeof errorText === 'string' ? errorText.trim() : '';
        if (!text || text === 'Codex error') {
            forwardCodexStatusToUi('Codex error');
            return;
        }
        forwardCodexStatusToUi(`Codex error: ${text}`);
    }

    let lastCodexSessionIdPersisted: string | null = null;

    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

        const lifecycle = nextCodexLifecycleAcpMessages({ currentTaskId, msg });
        currentTaskId = lifecycle.currentTaskId;
        for (const event of lifecycle.messages) {
            session.sendAgentMessage('codex', event);
        }

        const uiText = formatCodexEventForUi(msg);
        if (uiText) {
            forwardCodexStatusToUi(uiText);
        }

        // Persist Codex session id for later resume (fork-only).
        const nextId = client.getSessionId();
        if (typeof nextId === 'string' && nextId && nextId !== lastCodexSessionIdPersisted) {
            lastCodexSessionIdPersisted = nextId;
            session.updateMetadata((currentMetadata: any) => {
                if (currentMetadata.codexSessionId === nextId) {
                    return currentMetadata;
                }
                return {
                    ...currentMetadata,
                    codexSessionId: nextId,
                };
            });
            void updatePersistedHappySessionVendorResumeId(session.sessionId, nextId).catch((e) => {
                logger.debug('[Codex] Failed to persist vendor resume id', e);
            });
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
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
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session);
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
        let wasCreated = false;

        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
	            pending = null;
	            if (!message) {
	                // Capture the current signal to distinguish idle-abort from queue close
	                const waitSignal = abortController.signal;
	                const batch = await waitForMessagesOrPending({
	                    messageQueue,
	                    abortSignal: waitSignal,
	                    popPendingMessage: () => session.popPendingMessage(),
	                    waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
	                });
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

            // If a session exists and permission mode changed, restart on next iteration.
            // NOTE: This drops in-memory context (no resume attempt).
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const approvalPolicy = (() => {
                    switch (message.mode.permissionMode) {
                        // Codex native modes
                        case 'default': return 'untrusted' as const;                    // Ask for non-trusted commands
                        case 'read-only': return 'never' as const;                      // Never ask, read-only enforced by sandbox
                        case 'safe-yolo': return 'on-failure' as const;                 // Auto-run, ask only on failure
                        case 'yolo': return 'on-failure' as const;                      // Auto-run, ask only on failure
                        // Defensive fallback for Claude-specific modes (backward compatibility)
                        case 'bypassPermissions': return 'on-failure' as const;         // Full access: map to yolo behavior
                        case 'acceptEdits': return 'on-request' as const;               // Let model decide (closest to auto-approve edits)
                        case 'plan': return 'untrusted' as const;                       // Conservative: ask for non-trusted
                        default: return 'untrusted' as const;                           // Safe fallback
                    }
                })();
                const sandbox = (() => {
                    switch (message.mode.permissionMode) {
                        // Codex native modes
                        case 'default': return 'workspace-write' as const;              // Can write in workspace
                        case 'read-only': return 'read-only' as const;                  // Read-only filesystem
                        case 'safe-yolo': return 'workspace-write' as const;            // Can write in workspace
                        case 'yolo': return 'danger-full-access' as const;              // Full system access
                        // Defensive fallback for Claude-specific modes
                        case 'bypassPermissions': return 'danger-full-access' as const; // Full access: map to yolo
                        case 'acceptEdits': return 'workspace-write' as const;          // Can edit files in workspace
                        case 'plan': return 'workspace-write' as const;                 // Can write for planning
                        default: return 'workspace-write' as const;                     // Safe default
                    }
                })();

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION : message.message,
                        sandbox,
                        'approval-policy': approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    // NOTE: Model overrides are intentionally not supported for Codex.
                    // Codex's model selection is controlled by Codex itself (local config / default).

                    // Resume-by-session-id path (fork): seed codex-reply with the previous session id.
                    if (storedSessionIdForResume) {
                        const resumeId = storedSessionIdForResume;
                        storedSessionIdForResume = null; // consume once
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                        client.setSessionIdForResume(resumeId);
                        const resumeResponse = await client.continueSession(message.message, { signal: abortController.signal });
                        const resumeError = extractCodexToolErrorText(resumeResponse);
                        if (resumeError) {
                            forwardCodexErrorToUi(resumeError);
                            client.clearSession();
                            wasCreated = false;
                            currentModeHash = null;
                            continue;
                        }
                    } else {
                        const startResponse = await client.startSession(
                            startConfig,
                            { signal: abortController.signal }
                        );
                        const startError = extractCodexToolErrorText(startResponse);
                        if (startError) {
                            forwardCodexErrorToUi(startError);
                            client.clearSession();
                            wasCreated = false;
                            currentModeHash = null;
                            continue;
                        }
                    }

                    wasCreated = true;
                    first = false;
                } else {
                    const response = await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
                    const continueError = extractCodexToolErrorText(response);
                    if (continueError) {
                        forwardCodexErrorToUi(continueError);
                        client.clearSession();
                        wasCreated = false;
                        currentModeHash = null;
                        continue;
                    }
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    const details = formatErrorForUi(error);
                    const messageText = `Codex process error: ${details}`;
                    messageBuffer.addMessage(messageText, 'status');
                    session.sendSessionEvent({ type: 'message', message: messageText });
                    // For unexpected exits, try to store session for potential recovery
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                const popped = !shouldExit ? await session.popPendingMessage() : false;
                if (!popped) {
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => messageQueue.size(),
                        shouldExit,
                        sendReady,
                    });
                }
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
        logger.debug('[codex]: client.forceCloseSession begin');
        await client.forceCloseSession();
        logger.debug('[codex]: client.forceCloseSession done');
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

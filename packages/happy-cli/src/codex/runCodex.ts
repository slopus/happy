import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { createCodexBackend } from '@/agent/factories/codex';
import type { CodexAppServerBackend } from './appserver/CodexAppServerBackend';
import type { ApprovalPolicy, SandboxMode } from './appserver/types';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
// configuration and packageJson not currently used but kept for future use
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createMcpContext } from '@/agent/mcp';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import fs from 'node:fs';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
// trimIdent not currently used
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
// delay not currently used
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { downloadImage } from '@/utils/downloadImage';
import type { ImageContent } from '@/api/types';
import type { SendPromptOptions } from '@/agent/core';
import type { AgentMessage } from '@/agent/core';

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
 * Map Happy permission mode to Codex approval policy
 */
function mapApprovalPolicy(permissionMode: string): ApprovalPolicy {
    switch (permissionMode) {
        // Codex v0.98+: untrusted, on-failure, on-request, never
        case 'default': return 'on-request';
        case 'read-only': return 'untrusted';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'never';
        // Claude-compatible modes (backward compatibility)
        case 'bypassPermissions': return 'never';
        case 'acceptEdits': return 'on-failure';
        case 'plan': return 'on-request';
        default: return 'on-request';
    }
}

/**
 * Map Happy permission mode to Codex sandbox mode
 */
function mapSandbox(permissionMode: string): SandboxMode {
    switch (permissionMode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        case 'bypassPermissions': return 'danger-full-access';
        case 'acceptEdits': return 'workspace-write';
        case 'plan': return 'workspace-write';
        default: return 'workspace-write';
    }
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
        images?: ImageContent[];
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
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;

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
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        // Resolve permission mode
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Extract text and images based on content type (text-only or mixed)
        const isMixedContent = message.content.type === 'mixed';
        const messageText = message.content.text;
        const images: ImageContent[] = isMixedContent && 'images' in message.content
            ? message.content.images
            : [];

        if (images.length > 0) {
            logger.debug(`[Codex] Received mixed message with ${images.length} image(s)`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            images: images.length > 0 ? images : undefined,
        };
        messageQueue.push(messageText, enhancedMode);
    });
    let thinking = false;
    session.keepAlive(thinking, 'remote');
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
        // Mark task as completed in agent state for unread indicator
        session.updateAgentState((state) => ({
            ...state,
            taskCompleted: Date.now()
        }));
    };

    // Debug helper
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
    //

    let shouldExit = false;
    let storedSessionIdForResume: string | null = null;
    // Current backend instance (re-created on mode change)
    // Typed as any to prevent TS narrowing issues (assigned inside createBackend())
    let backend: any = null;

    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (backend?.isAlive && backend.getSessionId()) {
                storedSessionIdForResume = backend.getSessionId();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
                await backend.cancel(backend.getConversationId()!);
            }
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        }
    }

    // Start MCP servers with per-agent adapter (STDIO bridge for Codex)
    const mcp = await createMcpContext(session);
    const mcpServers = mcp.configForStdio();

    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            if (session) {
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

            try {
                await backend?.dispose();
            } catch (e) {
                logger.debug('[Codex] Error while disposing backend during termination', e);
            }

            stopCaffeinate();
            mcp.stop();

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
    // Set up processors and permission handler
    //

    permissionHandler = new CodexPermissionHandler(session);
    let messageSentThisTurn = false;

    const reasoningProcessor = new ReasoningProcessor((message) => {
        session.sendAgentMessage('codex', message);
        messageSentThisTurn = true;
    });
    const diffProcessor = new DiffProcessor((message) => {
        session.sendAgentMessage('codex', message);
        messageSentThisTurn = true;
    });

    /**
     * Handle AgentMessage from the backend.
     * Maps to UI updates + sends to Happy server via sendAgentMessage.
     */
    function handleAgentMessage(msg: AgentMessage): void {
        // Skip logging high-frequency streaming deltas
        if (msg.type !== 'model-output' && msg.type !== 'terminal-output' && msg.type !== 'event') {
            logger.debug(`[Codex] AgentMessage: ${msg.type}`);
        }

        switch (msg.type) {
            case 'model-output': {
                if (msg.fullText) {
                    messageBuffer.addMessage(msg.fullText, 'assistant');
                    session.sendAgentMessage('codex', {
                        type: 'message',
                        message: msg.fullText,
                    });
                    messageSentThisTurn = true;
                }
                // textDelta is streaming - we can accumulate or skip for UI
                break;
            }

            case 'status': {
                if (msg.status === 'running') {
                    messageBuffer.addMessage('Starting task...', 'status');
                    messageSentThisTurn = false;
                    if (!thinking) {
                        thinking = true;
                        session.keepAlive(thinking, 'remote');
                    }
                    session.sendAgentMessage('codex', { type: 'task_started', id: randomUUID() });
                } else if (msg.status === 'idle') {
                    const isAborted = msg.detail === 'aborted';
                    messageBuffer.addMessage(isAborted ? 'Turn aborted' : 'Task completed', 'status');

                    if (!messageSentThisTurn) {
                        session.sendAgentMessage('codex', {
                            type: 'message',
                            message: isAborted ? '[Codex turn aborted]' : '[Codex completed without response]',
                        });
                    }

                    session.sendAgentMessage('codex', {
                        type: isAborted ? 'turn_aborted' : 'task_complete',
                        id: randomUUID(),
                    });

                    if (thinking) {
                        thinking = false;
                        session.keepAlive(thinking, 'remote');
                    }
                    diffProcessor.reset();
                    // Note: sendReady() is called by emitReadyIfIdle() in the finally block
                    // to avoid sending duplicate push notifications
                } else if (msg.status === 'error') {
                    messageBuffer.addMessage(`Error: ${msg.detail ?? 'Unknown error'}`, 'status');
                    session.sendAgentMessage('codex', {
                        type: 'message',
                        message: `[Codex Error] ${msg.detail ?? 'Unknown error'}`,
                    });
                    messageSentThisTurn = true;
                }
                break;
            }

            case 'tool-call': {
                messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
                session.sendAgentMessage('codex', {
                    type: 'tool-call',
                    callId: msg.callId,
                    name: msg.toolName,
                    input: msg.args,
                    id: randomUUID(),
                });
                messageSentThisTurn = true;
                break;
            }

            case 'tool-result': {
                const output = typeof msg.result === 'string'
                    ? msg.result
                    : JSON.stringify(msg.result);
                const truncated = output.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncated}${output.length > 200 ? '...' : ''}`,
                    'result'
                );
                session.sendAgentMessage('codex', {
                    type: 'tool-result',
                    callId: msg.callId,
                    output: msg.result,
                    id: randomUUID(),
                });
                messageSentThisTurn = true;
                break;
            }

            case 'terminal-output': {
                // Streaming command output - skip for now (noisy in mobile UI)
                break;
            }

            case 'exec-approval-request': {
                session.sendAgentMessage('codex', {
                    type: 'tool-call',
                    callId: msg.call_id,
                    name: 'CodexBash',
                    input: msg,
                    id: randomUUID(),
                });
                messageSentThisTurn = true;
                break;
            }

            case 'patch-apply-begin': {
                const changeCount = Object.keys(msg.changes).length;
                const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
                session.sendAgentMessage('codex', {
                    type: 'tool-call',
                    callId: msg.call_id,
                    name: 'CodexPatch',
                    input: { auto_approved: msg.auto_approved, changes: msg.changes },
                    id: randomUUID(),
                });
                messageSentThisTurn = true;
                break;
            }

            case 'patch-apply-end': {
                if (msg.success) {
                    const text = msg.stdout || 'Files modified successfully';
                    messageBuffer.addMessage(text.substring(0, 200), 'result');
                } else {
                    const errMsg = msg.stderr || 'Failed to modify files';
                    messageBuffer.addMessage(`Error: ${errMsg.substring(0, 200)}`, 'result');
                }
                session.sendAgentMessage('codex', {
                    type: 'tool-result',
                    callId: msg.call_id,
                    output: { stdout: msg.stdout, stderr: msg.stderr, success: msg.success },
                    id: randomUUID(),
                });
                messageSentThisTurn = true;
                break;
            }

            case 'token-count': {
                const { type: _type, ...tokenData } = msg;
                session.sendAgentMessage('codex', {
                    type: 'token_count',
                    ...tokenData,
                });
                break;
            }

            case 'event': {
                // Handle reasoning events through processors
                if (msg.name === 'reasoning_delta') {
                    const payload = msg.payload as { delta: string };
                    reasoningProcessor.processDelta(payload.delta);
                } else if (msg.name === 'reasoning') {
                    const payload = msg.payload as { text: string };
                    messageBuffer.addMessage(`[Thinking] ${payload.text.substring(0, 100)}...`, 'system');
                    reasoningProcessor.complete(payload.text);
                } else if (msg.name === 'reasoning_section_break') {
                    reasoningProcessor.handleSectionBreak();
                } else if (msg.name === 'turn_diff') {
                    const payload = msg.payload as { unified_diff?: string };
                    if (payload.unified_diff) {
                        diffProcessor.processDiff(payload.unified_diff);
                    }
                } else if (msg.name === 'plan_update') {
                    // Forward plan updates to mobile
                    session.sendAgentMessage('codex', {
                        type: 'message',
                        message: `[Plan Update] ${JSON.stringify(msg.payload)}`,
                    });
                }
                break;
            }

            case 'permission-request':
            case 'permission-response':
            case 'fs-edit':
                // Handled by permission handler or backend internally
                break;
        }
    }

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter(full => full.endsWith(`-${sessionId}.jsonl`))
                .filter(full => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa;
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    /**
     * Create a new backend instance with the given configuration.
     * Disposes any existing backend first.
     */
    async function createBackend(opts: {
        model?: string;
        approvalPolicy: ApprovalPolicy;
        sandbox: SandboxMode;
        resumeFile?: string | null;
    }): Promise<CodexAppServerBackend> {
        // Dispose previous backend if exists
        if (backend?.isAlive) {
            try { await backend.dispose(); } catch { }
        }

        const { backend: newBackend } = createCodexBackend({
            cwd: process.cwd(),
            model: opts.model,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers,
            permissionHandler,
            resumeFile: opts.resumeFile,
        });

        backend = newBackend as unknown as CodexAppServerBackend;
        backend.onMessage(handleAgentMessage);
        return backend;
    }

    let first = true;

    try {
        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let nextResumeFile: string | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');

            // Get next message (check pending first from mode change)
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const batch = await messageQueue.waitForMessagesAndGetAsString();
                if (!batch) {
                    if (!shouldExit) {
                        logger.debug('[codex]: Wait returned null while not exiting; continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) break;

            // If mode changed, restart with new backend
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');

                // Try to find resume file from previous session
                try {
                    const prevSessionId = backend ? backend.getSessionId() : null;
                    nextResumeFile = findCodexResumeFile(prevSessionId);
                    if (nextResumeFile) {
                        logger.debug(`[Codex] Found resume file: ${nextResumeFile}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error searching resume file', e);
                }

                // Dispose old backend
                if (backend) { try { await backend.dispose(); } catch { } }
                backend = null;
                wasCreated = false;
                currentModeHash = null;
                pending = message;

                // Reset processors/permissions
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                const approvalPolicy = mapApprovalPolicy(message.mode.permissionMode);
                const sandbox = mapSandbox(message.mode.permissionMode);

                // Download images from URLs to base64 if present
                let promptOptions: SendPromptOptions | undefined;
                if (message.mode.images?.length) {
                    logger.debug(`[Codex] Downloading ${message.mode.images.length} image(s)...`);
                    const images = await Promise.all(
                        message.mode.images.map(async (img) => {
                            const downloaded = await downloadImage(img.url);
                            return {
                                data: downloaded.base64,
                                mimeType: downloaded.mimeType,
                            };
                        })
                    );
                    promptOptions = { images };
                    logger.debug(`[Codex] Downloaded ${images.length} image(s)`);
                }

                if (!wasCreated) {
                    // Build prompt
                    const promptText = first
                        ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION
                        : message.message;

                    // Determine resume file
                    let resumeFile: string | null = null;
                    if (nextResumeFile) {
                        resumeFile = nextResumeFile;
                        nextResumeFile = null;
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    } else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null;
                    }

                    // Create backend with the new configuration
                    await createBackend({
                        model: message.mode.model,
                        approvalPolicy,
                        sandbox,
                        resumeFile,
                    });

                    // Start session — if images present, start without prompt
                    // then send prompt+images via sendPrompt
                    if (promptOptions) {
                        await backend!.startSession();
                        wasCreated = true;
                        first = false;

                        await backend!.sendPrompt(
                            backend!.getConversationId()!,
                            promptText,
                            promptOptions
                        );
                    } else {
                        await backend!.startSession(promptText);
                        wasCreated = true;
                        first = false;
                    }

                    // Wait for this turn to complete
                    await backend!.waitForResponseComplete!();
                } else {
                    // Continue existing session with new prompt
                    await backend!.sendPrompt(
                        backend!.getConversationId()!,
                        message.message,
                        promptOptions
                    );

                    // Wait for this turn to complete
                    await backend!.waitForResponseComplete!();
                }
            } catch (error) {
                const errMsg = error instanceof Error
                    ? `${error.message}\n${error.stack}`
                    : JSON.stringify(error, null, 2);
                logger.warn('Error in codex session:', errMsg);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    // Store session for potential recovery
                    if (backend && backend.isAlive) {
                        storedSessionIdForResume = backend.getSessionId();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }
                }
            } finally {
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
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
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

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

        logger.debug('[codex]: backend.dispose begin');
        try { await backend?.dispose(); } catch { }
        logger.debug('[codex]: backend.dispose done');

        // Stop Happy MCP server
        logger.debug('[codex]: mcp.stop');
        mcp.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
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

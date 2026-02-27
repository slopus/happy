import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import fs from 'node:fs';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import type { CodexSessionConfig } from './types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';
import { parseSpecialCommand } from '@/parsers/specialCommands';

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
    const workingDirectory = process.cwd();

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
    let thinking = false;
    let sessionMode: 'local' | 'remote' = opts.startedBy === 'daemon' ? 'remote' : 'local';
    const applySessionControlState = (targetSession: ApiSessionClient, mode: 'local' | 'remote') => {
        targetSession.updateAgentState((currentState) => ({
            ...currentState,
            controlledByUser: mode === 'local'
        }));
        targetSession.keepAlive(thinking, mode);
    };
    const switchSessionMode = (nextMode: 'local' | 'remote', reason?: string) => {
        if (sessionMode === nextMode) {
            return;
        }
        sessionMode = nextMode;
        if (reason) {
            logger.debug(`[Codex] Session mode switched to ${nextMode}: ${reason}`);
        }
        session.sendSessionEvent({ type: 'switch', mode: nextMode });
        applySessionControlState(session, nextMode);
    };
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
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
            applySessionControlState(newSession, sessionMode);
        }
    });
    session = initialSession;
    applySessionControlState(session, sessionMode);

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

    session.onUserMessage((message) => {
        switchSessionMode('remote', 'mobile message received');

        // Resolve permission mode (accept all modes, will be mapped in switch statement)
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

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        messageQueue.push(message.content.text, enhancedMode);
    });
    const enqueueTerminalPrompt = (prompt: string) => {
        const text = prompt.trim();
        if (!text) {
            return;
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode || 'default',
            model: currentModel,
        };
        messageQueue.push(text, enhancedMode);
    };
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    session.keepAlive(thinking, sessionMode);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, sessionMode);
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

    const setupRemoteUi = () => {
        if (!hasTTY || inkInstance) {
            return;
        }

        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            getSessionMode: () => sessionMode,
            onSubmitPrompt: enqueueTerminalPrompt,
            onSwitchToLocal: async () => {
                if (sessionMode === 'local') {
                    return;
                }
                switchSessionMode('local', 'keyboard shortcut');
                await handleAbort();
            },
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

        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    };

    const teardownRemoteUi = () => {
        if (!hasTTY) {
            return;
        }
        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch {}
        }
        try { process.stdin.pause(); } catch {}
        if (inkInstance) {
            inkInstance.unmount();
            inkInstance = null;
        }
    };

    //
    // Start Context 
    //

    const client = new CodexMcpClient(sandboxConfig);

    // Helper: find Codex session transcript for a given sessionId
    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            // Recursively collect all files under the sessions directory
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
                    return sb - sa; // newest first
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    function normalizePath(pathValue: string): string {
        return resolve(pathValue).replace(/[\\\/]+$/, '');
    }

    function parseSessionTimestamp(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value !== 'string') {
            return null;
        }
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            return null;
        }
        return parsed;
    }

    function findRecentCodexSessionId(cwd: string, referenceTimestampMs: number): string | null {
        const normalizedCwd = normalizePath(cwd);
        const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
        const sessionsRoot = join(codexHomeDir, 'sessions');
        const windowMs = 2 * 60 * 1000;

        const collectFilesRecursive = (dir: string, acc: string[] = []): string[] => {
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
                    continue;
                }
                if (entry.isFile() && full.endsWith('.jsonl')) {
                    acc.push(full);
                }
            }
            return acc;
        };

        const files = collectFilesRecursive(sessionsRoot).sort((a, b) => {
            const mtimeA = fs.statSync(a).mtimeMs;
            const mtimeB = fs.statSync(b).mtimeMs;
            return mtimeB - mtimeA;
        });

        let fallbackSessionId: string | null = null;
        for (const filePath of files) {
            let content: string;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                continue;
            }

            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(trimmed) as { type?: string; payload?: Record<string, unknown> };
                    if (parsed?.type !== 'session_meta' || !parsed.payload) {
                        continue;
                    }
                    const sessionId = typeof parsed.payload.id === 'string' ? parsed.payload.id : null;
                    const payloadCwd = typeof parsed.payload.cwd === 'string' ? normalizePath(parsed.payload.cwd) : null;
                    if (!sessionId || payloadCwd !== normalizedCwd) {
                        continue;
                    }
                    if (!fallbackSessionId) {
                        fallbackSessionId = sessionId;
                    }
                    const sessionTimestamp = parseSessionTimestamp(parsed.payload.timestamp);
                    if (sessionTimestamp !== null && sessionTimestamp >= referenceTimestampMs - windowMs) {
                        return sessionId;
                    }
                } catch {
                    continue;
                }
            }
        }

        return fallbackSessionId;
    }
    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
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
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

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
                session.keepAlive(thinking, sessionMode);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, sessionMode);
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
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { auto_approved, changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }

        // Convert Codex MCP events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
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

    const escapeTomlString = (value: string): string => value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');

    const escapeTomlLiteralString = (value: string): string => value.replace(/'/g, "''");

    const buildCodexLocalMcpArgs = (): string[] => {
        const args: string[] = [];
        for (const [name, server] of Object.entries(mcpServers)) {
            args.push('-c', `mcp_servers.${name}.command="${escapeTomlString(server.command)}"`);
            const arrayValue = `[${server.args.map((arg) => `'${escapeTomlLiteralString(arg)}'`).join(',')}]`;
            args.push('-c', `mcp_servers.${name}.args=${arrayValue}`);
        }
        args.push('-c', `developer_instructions="${escapeTomlString(CHANGE_TITLE_INSTRUCTION)}"`);
        return args;
    };

    const runCodexLocalInteractive = async (): Promise<'switch' | 'exit'> => {
        if (sessionMode !== 'local' || !hasTTY) {
            return 'switch';
        }

        logger.debug('[Codex] Starting native local Codex mode');
        const localStartTimestampMs = Date.now();
        const localArgs = buildCodexLocalMcpArgs();
        const localAbortController = new AbortController();
        let shouldSwitchToRemote = false;
        let exitCode = 0;

        const requestSwitchToRemote = (reason: string) => {
            if (shouldSwitchToRemote) {
                return;
            }
            shouldSwitchToRemote = true;
            switchSessionMode('remote', reason);
            localAbortController.abort();
        };

        const handleLocalSwitch = async () => {
            requestSwitchToRemote('switch requested while local');
        };
        const handleLocalAbort = async () => {
            requestSwitchToRemote('abort requested while local');
        };

        messageQueue.setOnMessage((messageText) => {
            logger.debug(`[Codex] Local mode interrupted by remote message: ${messageText.slice(0, 80)}`);
            requestSwitchToRemote('remote message received');
        });
        session.rpcHandlerManager.registerHandler('switch', handleLocalSwitch);
        session.rpcHandlerManager.registerHandler('abort', handleLocalAbort);

        try {
            await new Promise<void>((resolvePromise, rejectPromise) => {
                const child = spawn('codex', localArgs, {
                    cwd: workingDirectory,
                    env: process.env,
                    stdio: 'inherit',
                    signal: localAbortController.signal,
                    shell: process.platform === 'win32',
                });

                child.on('error', (error) => {
                    if (localAbortController.signal.aborted && shouldSwitchToRemote) {
                        resolvePromise();
                        return;
                    }
                    rejectPromise(error);
                });

                child.on('exit', (code) => {
                    exitCode = typeof code === 'number' ? code : 0;
                    resolvePromise();
                });
            });
        } catch (error) {
            if (!(localAbortController.signal.aborted && shouldSwitchToRemote)) {
                throw error;
            }
        } finally {
            messageQueue.setOnMessage(null);
            session.rpcHandlerManager.registerHandler('switch', async () => {});
            session.rpcHandlerManager.registerHandler('abort', handleAbort);
        }

        const detectedSessionId = findRecentCodexSessionId(workingDirectory, localStartTimestampMs);
        if (detectedSessionId) {
            storedSessionIdForResume = detectedSessionId;
            logger.debug(`[Codex] Local mode detected session for resume: ${detectedSessionId}`);
        } else {
            logger.debug('[Codex] Local mode could not detect resume session id');
        }

        if (shouldSwitchToRemote) {
            return 'switch';
        }

        if (exitCode !== 0) {
            logger.debug(`[Codex] Local Codex exited with code ${exitCode}`);
        }
        return 'exit';
    };

    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        // If we restart (e.g., mode change), use this to carry a resume file
        let nextExperimentalResume: string | null = null;

        while (!shouldExit) {
            if (sessionMode === 'local') {
                teardownRemoteUi();
                const localResult = await runCodexLocalInteractive();
                if (localResult === 'exit') {
                    shouldExit = true;
                    break;
                }

                setupRemoteUi();
                // New remote session should start after returning from local mode
                wasCreated = false;
                currentModeHash = null;
                pending = null;
                nextExperimentalResume = null;
                continue;
            }

            setupRemoteUi();
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
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

            const specialCommand = parseSpecialCommand(message.message);
            if (specialCommand.type === 'clear') {
                logger.debug('[Codex] /clear command detected - resetting context');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });

                client.clearSession();
                wasCreated = false;
                first = true;
                currentModeHash = null;
                pending = null;
                nextExperimentalResume = null;
                storedSessionIdForResume = null;

                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, sessionMode);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            if (specialCommand.type === 'compact') {
                logger.debug('[Codex] /compact command detected');
                session.sendSessionEvent({ type: 'message', message: 'Compaction started' });
            }

            // If a session exists and mode changed, restart on next iteration
            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                // Capture previous sessionId and try to find its transcript to resume
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (e) {
                    logger.debug('[Codex] Error while searching resume file', e);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                // Reset processors/permissions like end-of-turn cleanup
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, sessionMode);
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                if (!wasCreated) {
                    const startConfig: CodexSessionConfig = {
                        prompt: first ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION : message.message,
                        sandbox: executionPolicy.sandbox,
                        'approval-policy': executionPolicy.approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }
                    
                    // Check for resume file from multiple sources
                    let resumeFile: string | null = null;
                    
                    // Priority 1: Explicit resume file from mode change
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null; // consume once
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    }
                    // Priority 2: Resume from stored abort session
                    else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null; // consume once
                    }
                    
                    // Apply resume file if found
                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }
                    
                    await client.startSession(
                        startConfig,
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                    first = false;
                } else {
                    const response = await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                    logger.debug('[Codex] continueSession response:', response);
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
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
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
                session.keepAlive(thinking, sessionMode);
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

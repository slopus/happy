import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
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
import type { Session as HappySession } from '@/api/types';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

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

export function normalizeResumeUserText(text: string): string {
    return text.replace(/\r\n/g, '\n').trim();
}

export function filterBufferedResumeMessages<T extends { text: string }>(
    messages: T[],
    recentResumeUserTexts: Set<string>,
): T[] {
    return messages.filter(({ text }) => (
        !recentResumeUserTexts.has(normalizeResumeUserText(text))
    ));
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

    const sessionTag = process.env.HAPPY_SESSION_TAG_OVERRIDE || randomUUID();

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
    let currentCodexSessionId: string | null = null;
    let currentCodexConversationId: string | null = null;
    let bootResumeFile: string | null = null;

    const loadCodexIdentifiersFromSnapshot = (): boolean => {
        const restoreSessionId = process.env.HAPPY_RESTORE_SESSION_ID;
        const restoreSessionTag = process.env.HAPPY_RESTORE_SESSION_TAG || sessionTag;
        const candidates: string[] = [];
        if (restoreSessionId) {
            candidates.push(join(os.homedir(), '.happy-session-crypto', `session-${restoreSessionId}.json`));
        }
        if (restoreSessionTag) {
            candidates.push(join(os.homedir(), '.happy-session-crypto', `tag-${restoreSessionTag}.json`));
        }

        for (const candidatePath of candidates) {
            try {
                if (!fs.existsSync(candidatePath)) {
                    continue;
                }
                const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
                const sid = typeof parsed?.codexSessionId === 'string' && parsed.codexSessionId.length > 0
                    ? parsed.codexSessionId
                    : null;
                const cid = typeof parsed?.codexConversationId === 'string' && parsed.codexConversationId.length > 0
                    ? parsed.codexConversationId
                    : null;
                if (!sid && !cid) {
                    continue;
                }
                currentCodexSessionId = sid || cid;
                currentCodexConversationId = cid || sid;
                logger.debug('[SessionCrypto] Loaded codex identifiers from snapshot', {
                    source: candidatePath,
                    codexSessionId: currentCodexSessionId,
                    codexConversationId: currentCodexConversationId
                });
                return true;
            } catch (error) {
                logger.debug(`[SessionCrypto] Failed loading codex identifiers from ${candidatePath}`, error);
            }
        }

        return false;
    };

    const persistSessionSnapshot = (sessionToPersist: ApiSessionClient | HappySession): void => {
        try {
            const rawSession = sessionToPersist as any;
            const persistedSessionId = rawSession?.id || rawSession?.sessionId;
            const persistedEncryptionKey = rawSession?.encryptionKey;
            const persistedEncryptionVariant = rawSession?.encryptionVariant;

            if (!persistedSessionId || !persistedEncryptionKey || !persistedEncryptionVariant) {
                return;
            }
            const snapshotDir = join(os.homedir(), '.happy-session-crypto');
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
            }

            const payload: Record<string, any> = {
                sessionId: persistedSessionId,
                sessionTag,
                encryptionVariant: persistedEncryptionVariant,
                encryptionKeyBase64: Buffer.from(persistedEncryptionKey).toString('base64'),
                savedAt: Date.now()
            };

            if (currentCodexSessionId) {
                payload.codexSessionId = currentCodexSessionId;
            }
            if (currentCodexConversationId) {
                payload.codexConversationId = currentCodexConversationId;
            }

            const sessionPath = join(snapshotDir, `session-${persistedSessionId}.json`);
            const tagPath = join(snapshotDir, `tag-${sessionTag}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
            fs.writeFileSync(tagPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
            logger.debug(`[SessionCrypto] Persisted session snapshot: ${persistedSessionId} (tag: ${sessionTag})`);
        } catch (error) {
            logger.debug('[SessionCrypto] Failed to persist session snapshot', error);
        }
    };

    const loadFallbackSessionFromSnapshot = (): HappySession | null => {
        const restoreSessionId = process.env.HAPPY_RESTORE_SESSION_ID;
        const restoreSessionTag = process.env.HAPPY_RESTORE_SESSION_TAG || sessionTag;
        const candidates: string[] = [];
        if (restoreSessionId) {
            candidates.push(join(os.homedir(), '.happy-session-crypto', `session-${restoreSessionId}.json`));
        }
        if (restoreSessionTag) {
            candidates.push(join(os.homedir(), '.happy-session-crypto', `tag-${restoreSessionTag}.json`));
        }

        for (const candidatePath of candidates) {
            try {
                if (!fs.existsSync(candidatePath)) {
                    continue;
                }
                const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
                if (!parsed?.sessionId || !parsed?.encryptionKeyBase64 || !parsed?.encryptionVariant) {
                    continue;
                }

                if (typeof parsed.codexSessionId === 'string' && parsed.codexSessionId.length > 0) {
                    currentCodexSessionId = parsed.codexSessionId;
                }
                if (typeof parsed.codexConversationId === 'string' && parsed.codexConversationId.length > 0) {
                    currentCodexConversationId = parsed.codexConversationId;
                }
                if (!currentCodexSessionId && currentCodexConversationId) {
                    currentCodexSessionId = currentCodexConversationId;
                }
                if (!currentCodexConversationId && currentCodexSessionId) {
                    currentCodexConversationId = currentCodexSessionId;
                }

                const encryptionKey = Uint8Array.from(Buffer.from(parsed.encryptionKeyBase64, 'base64'));
                logger.debug(`[SessionCrypto] Loaded fallback snapshot from ${candidatePath}`);
                return {
                    id: parsed.sessionId,
                    seq: 0,
                    metadata,
                    metadataVersion: 0,
                    agentState: state,
                    agentStateVersion: 0,
                    encryptionKey,
                    encryptionVariant: parsed.encryptionVariant
                };
            } catch (error) {
                logger.debug(`[SessionCrypto] Failed loading fallback snapshot from ${candidatePath}`, error);
            }
        }

        return null;
    };

    loadCodexIdentifiersFromSnapshot();

    let response: HappySession | null = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (!response) {
        const fallbackResponse = loadFallbackSessionFromSnapshot();
        if (fallbackResponse) {
            response = fallbackResponse;
            logger.debug(`[SessionCrypto] Using fallback snapshot session: ${fallbackResponse.id}`);
        }
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
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
            persistSessionSnapshot(newSession);
            notifyDaemonSessionStarted(newSession.sessionId, metadata).then((result) => {
                if (result?.error) {
                    logger.debug(`[START] Failed to report swapped session to daemon:`, result.error);
                } else {
                    logger.debug(`[START] Reported swapped session ${newSession.sessionId} to daemon`);
                }
            }).catch((error) => {
                logger.debug('[START] Failed to report swapped session to daemon (exception):', error);
            });
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;
    persistSessionSnapshot(initialSession);

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
    let resumeBootstrapPending = false;
    let recentResumeUserTexts = new Set<string>();
    const bufferedResumeMessages: Array<{ text: string; mode: EnhancedMode }> = [];

    function flushBufferedResumeMessages() {
        if (!bufferedResumeMessages.length) {
            return;
        }

        const pendingMessages = bufferedResumeMessages.splice(0);
        const filteredMessages = filterBufferedResumeMessages(pendingMessages, recentResumeUserTexts);
        const droppedCount = pendingMessages.length - filteredMessages.length;

        if (droppedCount > 0) {
            logger.debug('[Codex] Dropped duplicate pre-resume user messages', {
                droppedCount,
                keptCount: filteredMessages.length
            });
        }

        for (const { text, mode } of filteredMessages) {
            messageQueue.push(text, mode);
        }
    }

    session.onUserMessage((message) => {
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
        if (resumeBootstrapPending) {
            logger.debug('[Codex] Buffering user message until saved Codex thread resume completes');
            bufferedResumeMessages.push({
                text: message.content.text,
                mode: enhancedMode
            });
            return;
        }
        messageQueue.push(message.content.text, enhancedMode);
    });
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
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

    const useRestoreClient = Boolean(currentCodexSessionId || currentCodexConversationId);
    logger.debug(useRestoreClient ? '[Codex] Using app-server restore client' : '[Codex] Using MCP client');
    const client: CodexMcpClient | CodexAppServerClient = useRestoreClient
        ? new CodexAppServerClient()
        : new CodexMcpClient(sandboxConfig);

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

    function readResumeTranscriptMessages(resumeFile: string | null): Array<{ role: 'User' | 'Assistant'; text: string }> {
        if (!resumeFile) return [];
        try {
            const raw = fs.readFileSync(resumeFile, 'utf8');
            const lines = raw.split('\n').filter((line) => line.trim().length > 0);
            const messages: Array<{ role: 'User' | 'Assistant'; text: string }> = [];
            for (const line of lines) {
                let parsed: any;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }

                if (parsed?.type !== 'response_item' || parsed?.payload?.type !== 'message') {
                    continue;
                }

                const role = parsed.payload.role === 'user'
                    ? 'User'
                    : parsed.payload.role === 'assistant'
                        ? 'Assistant'
                        : null;
                if (!role || !Array.isArray(parsed.payload.content)) {
                    continue;
                }

                const text = parsed.payload.content
                    .map((item: any) => {
                        if (role === 'User' && item?.type === 'input_text' && typeof item.text === 'string') {
                            return item.text;
                        }
                        if (role === 'Assistant' && item?.type === 'output_text' && typeof item.text === 'string') {
                            return item.text;
                        }
                        return '';
                    })
                    .filter(Boolean)
                    .join('\n')
                    .trim();
                if (!text) {
                    continue;
                }

                const last = messages[messages.length - 1];
                if (last && last.role === role && last.text === text) {
                    continue;
                }
                messages.push({ role, text });
            }

            return messages;
        } catch (error) {
            logger.debug('[Codex] Failed to build resume prompt context', error);
            return [];
        }
    }

    function buildRecentResumeUserTexts(resumeFile: string | null): Set<string> {
        const messages = readResumeTranscriptMessages(resumeFile);
        const recentUsers = messages
            .filter((message) => message.role === 'User')
            .slice(-24)
            .map((message) => normalizeResumeUserText(message.text))
            .filter(Boolean);
        return new Set(recentUsers);
    }

    function buildResumePromptContext(resumeFile: string | null): string {
        const messages = readResumeTranscriptMessages(resumeFile);
        if (!messages.length) {
            return '';
        }

        const selected: string[] = [];
        let totalChars = 0;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const formatted = `${messages[i].role}: ${messages[i].text}`;
            if (selected.length >= 24 || totalChars + formatted.length > 12000) {
                break;
            }
            selected.push(formatted);
            totalChars += formatted.length + 2;
        }
        selected.reverse();

        return [
            'Restored context from the previous unavailable Codex thread.',
            'Treat the following transcript as prior conversation state and preserved memory.',
            ...selected
        ].join('\n\n');
    }

    if (currentCodexSessionId) {
        bootResumeFile = findCodexResumeFile(currentCodexSessionId);
        if (bootResumeFile) {
            logger.debug('[Codex] Found resume file from session snapshot:', bootResumeFile);
            recentResumeUserTexts = buildRecentResumeUserTexts(bootResumeFile);
        } else {
            logger.debug(`[Codex] No resume file found for snapshot codex session ${currentCodexSessionId}`);
        }
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
        const messageThreadId = typeof msg?.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : null;
        if (messageThreadId && (messageThreadId !== currentCodexSessionId || messageThreadId !== currentCodexConversationId)) {
            currentCodexSessionId = messageThreadId;
            currentCodexConversationId = messageThreadId;
            logger.debug('[SessionCrypto] Updated codex identifiers', {
                sessionId: session.sessionId,
                codexSessionId: currentCodexSessionId,
                codexConversationId: currentCodexConversationId
            });
            persistSessionSnapshot(session);
        }

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
    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let wasCreated = false;
        if (currentCodexSessionId || currentCodexConversationId) {
            client.seedSessionIdentifiers(currentCodexSessionId, currentCodexConversationId);
            wasCreated = true;
            resumeBootstrapPending = true;
            logger.debug('[Codex] Seeded client with saved identifiers; first turn will attempt continueSession');
            messageBuffer.addMessage('Attempting to resume saved Codex thread...', 'status');
            if (client instanceof CodexAppServerClient) {
                const bootstrapExecutionPolicy = resolveCodexExecutionPolicy(
                    currentPermissionMode ?? 'default',
                    client.sandboxEnabled,
                );
                const bootstrapConfig: Partial<CodexSessionConfig> = {
                    sandbox: bootstrapExecutionPolicy.sandbox,
                    'approval-policy': bootstrapExecutionPolicy.approvalPolicy,
                };
                if (currentModel) {
                    bootstrapConfig.model = currentModel;
                }
                try {
                    await client.resumeSavedThread(
                        bootstrapConfig,
                        { signal: abortController.signal }
                    );
                } catch (error) {
                    logger.debug('[Codex] Initial saved-thread resume bootstrap failed', error);
                } finally {
                    resumeBootstrapPending = false;
                    flushBufferedResumeMessages();
                }
            } else {
                resumeBootstrapPending = false;
                flushBufferedResumeMessages();
            }
        }
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        // If we restart (e.g., mode change), use this to carry a resume file
        let nextExperimentalResume: string | null = null;

        while (!shouldExit) {
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
                session.keepAlive(thinking, 'remote');
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
                const startNewSession = async () => {
                    const basePrompt = first ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION : message.message;
                    const startConfig: CodexSessionConfig = {
                        prompt: basePrompt,
                        sandbox: executionPolicy.sandbox,
                        'approval-policy': executionPolicy.approvalPolicy,
                        config: { mcp_servers: mcpServers }
                    };
                    if (message.mode.model) {
                        startConfig.model = message.mode.model;
                    }

                    let resumeFile: string | null = null;

                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null;
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    } else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null;
                    } else if (bootResumeFile) {
                        resumeFile = bootResumeFile;
                        bootResumeFile = null;
                        logger.debug('[Codex] Using resume file from session snapshot:', resumeFile);
                        messageBuffer.addMessage('Resuming saved context...', 'status');
                    }

                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                        const resumePromptContext = buildResumePromptContext(resumeFile);
                        if (resumePromptContext) {
                            startConfig.prompt = `${resumePromptContext}\n\nCurrent user message:\n${basePrompt}`;
                        }
                    }

                    await client.startSession(
                        startConfig,
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                    first = false;
                };

                if (!wasCreated) {
                    await startNewSession();
                } else {
                    try {
                        const continueConfig: Partial<CodexSessionConfig> = {
                            sandbox: executionPolicy.sandbox,
                            'approval-policy': executionPolicy.approvalPolicy
                        };
                        if (message.mode.model) {
                            continueConfig.model = message.mode.model;
                        }

                        const response = await client.continueSession(
                            message.message,
                            {
                                signal: abortController.signal,
                                happyConfig: continueConfig
                            }
                        );
                        logger.debug('[Codex] continueSession response:', response);

                        const continueErrorText = (() => {
                            const typedResponse = response as any;
                            if (!typedResponse?.isError) {
                                return '';
                            }
                            if (typeof typedResponse?.structuredContent?.content === 'string') {
                                return typedResponse.structuredContent.content;
                            }
                            if (Array.isArray(typedResponse?.content)) {
                                return typedResponse.content
                                    .map((item: any) => typeof item?.text === 'string' ? item.text : '')
                                    .filter(Boolean)
                                    .join('\n');
                            }
                            return '';
                        })();

                        if (continueErrorText && (/session not found/i.test(continueErrorText) || /thread_id/i.test(continueErrorText))) {
                            throw new Error(continueErrorText);
                        }

                        first = false;
                    } catch (continueError) {
                        const continueMessage = continueError instanceof Error
                            ? `${continueError.name}: ${continueError.message}`
                            : String(continueError);
                        const shouldStartNewSession =
                            /no active session/i.test(continueMessage) ||
                            /not found/i.test(continueMessage) ||
                            /invalid/i.test(continueMessage);
                        if (!shouldStartNewSession) {
                            throw continueError;
                        }

                        logger.debug('[Codex] continueSession failed; falling back to startSession', continueError);
                        messageBuffer.addMessage('Resume failed, starting a new session...', 'status');
                        client.clearSession();
                        wasCreated = false;
                        await startNewSession();
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

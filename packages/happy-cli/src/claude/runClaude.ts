import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, ImageContent, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { createMcpContext } from '@/agent/mcp';
import { startHookServer } from '@/claude/utils/startHookServer';
import { backfillClaudeSessionHistory } from '@/claude/utils/claudeBackfill';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve, join } from 'node:path';
import { detectGitWorktree } from '@/utils/gitWorktree';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { Session } from './session';
import { findClaudeProjectId } from '@/claude/utils/claudeSessionIndex';
import { getProjectPath } from '@/claude/utils/path';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

/**
 * Message content type for the queue.
 * Can be a plain string (text-only) or a structured object (with images).
 */
export type QueueMessageContent =
    | string
    | { type: 'text'; text: string }
    | { type: 'mixed'; text: string; images: ImageContent[] };

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
}

/** Env vars from daemon take priority; otherwise detect via git */
function detectWorktreeMetadata(cwd: string): Partial<Metadata> {
    // New: multi-repo workspace
    if (process.env.HAPPY_WORKSPACE_REPOS) {
        try {
            const repos = JSON.parse(process.env.HAPPY_WORKSPACE_REPOS);
            return {
                isWorktree: true,
                workspaceRepos: repos,
                workspacePath: process.env.HAPPY_WORKSPACE_PATH,
            };
        } catch {
            // Fall through to legacy detection
        }
    }
    // Legacy: single-repo worktree (env vars from daemon)
    if (process.env.HAPPY_WORKTREE_BASE_PATH) {
        return {
            isWorktree: true,
            worktreeBasePath: process.env.HAPPY_WORKTREE_BASE_PATH,
            worktreeBranchName: process.env.HAPPY_WORKTREE_BRANCH_NAME,
        };
    }
    // Terminal: git auto-detection
    const info = detectGitWorktree(cwd);
    if (info.isWorktree) {
        return {
            isWorktree: true,
            worktreeBasePath: info.worktreeBasePath,
            worktreeBranchName: info.worktreeBranchName,
        };
    }
    return {};
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode. Use --happy-starting-mode remote or spawn sessions directly from terminal.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/hitosea/happy/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        // Worktree metadata: env vars from daemon take priority, otherwise detect via git
        ...detectWorktreeMetadata(workingDirectory),
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable case - run Claude locally with hot reconnection
    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        let offlineSessionId: string | null = null;

        const reconnection = startOfflineReconnection({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const session = api.sessionSyncClient(resp);
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (msg) => session.sendClaudeSessionMessage(msg)
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { session, scanner };
            },
            onNotify: console.log,
            onCleanup: () => {
                // Scanner cleanup handled automatically when process exits
            }
        });

        try {
            await claudeLocal({
                path: workingDirectory,
                sessionId: null,
                onSessionFound: (id) => { offlineSessionId = id; },
                onThinkingChange: () => {},
                abort: new AbortController().signal,
                claudeEnvVars: options.claudeEnvVars,
                claudeArgs: options.claudeArgs,
                mcpServers: {},
                allowedTools: []
            });
        } finally {
            reconnection.cancel();
            stopCaffeinate();
        }
        process.exit(0);
    }

    logger.debug(`Session created: ${response.id}`);

    // Always report to daemon if it exists
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

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            // Update session metadata with tools and slash commands
            api.sessionSyncClient(response).updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

    // Create realtime session
    const session = api.sessionSyncClient(response);
    const sessionTitle = process.env.HAPPY_SESSION_TITLE?.trim();
    const initialClaudeSessionId = process.env.HAPPY_CLAUDE_RESUME_SESSION_ID?.trim();
    const skipForkSession = process.env.HAPPY_CLAUDE_SKIP_FORK_SESSION === '1';

    // Set initial metadata (title and/or claudeSessionId) if available
    // Only set claudeSessionId if skipForkSession is true (pre-forked session like duplicate)
    // Otherwise, Claude will create a new session ID via --fork-session and onSessionFound will update it
    if (sessionTitle || (initialClaudeSessionId && skipForkSession)) {
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            ...(sessionTitle && {
                summary: {
                    text: sessionTitle,
                    updatedAt: Date.now()
                }
            }),
            ...(initialClaudeSessionId && skipForkSession && {
                claudeSessionId: initialClaudeSessionId
            })
        }));
    }

    // Start MCP servers (Happy MCP etc.) with per-agent adapter
    const mcp = await createMcpContext(session);
    logger.debug(`[START] MCP context created`);

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: Session | null = null;

    const shouldBackfill = ['1', 'true', 'yes'].includes(String(process.env.HAPPY_CLAUDE_BACKFILL).toLowerCase());
    const backfillMaxMessages = Number(process.env.HAPPY_CLAUDE_BACKFILL_MAX_MESSAGES) || 200;
    const backfillMaxUserMessages = Number(process.env.HAPPY_CLAUDE_BACKFILL_MAX_USER_MESSAGES) || 20;
    const backfillMaxBytes = Number(process.env.HAPPY_CLAUDE_BACKFILL_MAX_BYTES) || 3 * 1024 * 1024;
    const resumeSessionId = process.env.HAPPY_CLAUDE_RESUME_SESSION_ID || undefined;
    const backfilledSessions = new Set<string>();
    const backfillInFlight = new Set<string>();

    const ensureResumeSessionFileAvailable = async (sessionId: string) => {
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude');
        const resolvedProjectDir = getProjectPath(workingDirectory);
        const rawProjectId = workingDirectory.replace(/[\\\/\.: _]/g, '-');
        const rawProjectDir = join(claudeConfigDir, 'projects', rawProjectId);
        const targetDirs = new Set([resolvedProjectDir, rawProjectDir]);

        const sourceProjectId = await findClaudeProjectId(sessionId);
        if (!sourceProjectId) {
            logger.debug(`[START] Resume session file not found in any Claude project: ${sessionId}`);
            return;
        }

        const sourcePath = join(claudeConfigDir, 'projects', sourceProjectId, `${sessionId}.jsonl`);
        logger.debug(`[START] Resume session file source: ${sourcePath}`);

        for (const targetDir of targetDirs) {
            const targetPath = join(targetDir, `${sessionId}.jsonl`);
            if (targetPath === sourcePath) {
                logger.debug(`[START] Resume session file already present (source): ${targetPath}`);
                continue;
            }
            try {
                await stat(targetPath);
                logger.debug(`[START] Resume session file already present: ${targetPath}`);
                continue;
            } catch {
                // File missing; we'll copy it below.
            }

            try {
                await mkdir(targetDir, { recursive: true });
                await copyFile(sourcePath, targetPath);
                logger.debug(`[START] Copied resume session file into project dir: ${targetPath}`);
            } catch (error) {
                logger.debug('[START] Resume session copy error details', { targetPath, error });
            }
        }
    };

    const runBackfill = async (sessionId: string) => {
        if (!shouldBackfill) return;
        if (backfilledSessions.has(sessionId)) return;
        if (backfillInFlight.has(sessionId)) return;
        backfillInFlight.add(sessionId);

        // Wait briefly for socket connection to avoid dropping backfill messages
        for (let i = 0; i < 15 && !session.isConnected(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!session.isConnected()) {
            logger.debug('[START] Backfill skipped: session socket not connected');
            backfillInFlight.delete(sessionId);
            return;
        }

        try {
            await backfillClaudeSessionHistory({
                workingDirectory,
                sessionId,
                sendBatch: async (messages) => {
                    await session.sendClaudeSessionMessageBatch(messages, 'replace');
                },
                maxMessages: backfillMaxMessages,
                maxUserMessages: backfillMaxUserMessages,
                maxBytes: backfillMaxBytes
            });
            backfilledSessions.add(sessionId);
        } finally {
            backfillInFlight.delete(sessionId);
        }
    };

    // If we already know the resume session ID, backfill immediately (don't wait for hook)
    if (resumeSessionId) {
        await ensureResumeSessionFileAvailable(resumeSessionId);
        runBackfill(resumeSessionId).catch((error) => {
            logger.debug('[START] Backfill failed:', error);
        });
    }

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);
            
            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }

            // Backfill history for resumed sessions (once per session ID)
            runBackfill(sessionId).catch((error) => {
                logger.debug('[START] Backfill failed:', error);
            });
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    // The queue accepts QueueMessageContent which can be string or structured content with images
    const messageQueue = new MessageQueue2<EnhancedMode, QueueMessageContent>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode | undefined = options.permissionMode;
    let currentModel = options.model; // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    session.onUserMessage((message) => {

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, enhancedMode);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools
        };

        // Pass full content object for mixed messages (with images), otherwise just text
        if (message.content.type === 'mixed') {
            messageQueue.push(message.content, enhancedMode);
        } else {
            messageQueue.push(message.content.text, enhancedMode);
        }
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

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
                
                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            mcp.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        cleanup();
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        cleanup();
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        allowedTools: mcp.allowedToolNames(),
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
        },
        mcpServers: mcp.configForClaude(),
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        hookSettingsPath,
        jsRuntime: options.jsRuntime
    });

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Happy MCP server
    mcp.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}

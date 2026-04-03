import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { SyncBridge } from '@/api/syncBridge';
import { resolveSessionScopedSyncNodeToken } from '@/api/syncNodeToken';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { extractSDKMetadataAsync } from '@/claude/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { Session } from './session';
import { applySandboxPermissionPolicy, resolveInitialClaudePermissionMode } from './utils/permissionMode';
import type { SessionID } from '@slopus/happy-sync';
import { getUserMessageText } from '@/session/acpxTurn';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    noSandbox?: boolean
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
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
    const sandboxConfig = options.noSandbox ? undefined : settings?.sandboxConfig;
    const sandboxEnabled = Boolean(sandboxConfig?.enabled);
    const initialPermissionMode = applySandboxPermissionPolicy(
        resolveInitialClaudePermissionMode(options.permissionMode, options.claudeArgs),
        sandboxEnabled,
    );
    const dangerouslySkipPermissions =
        initialPermissionMode === 'bypassPermissions' ||
        initialPermissionMode === 'yolo' ||
        sandboxEnabled ||
        Boolean(options.claudeArgs?.includes('--dangerously-skip-permissions'));
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
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
        sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
        dangerouslySkipPermissions,
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
                // TODO: create SyncBridge for reconnected session
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (_msg) => { /* offline reconnect message handler */ }
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { scanner };
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
                allowedTools: [],
                sandboxConfig,
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

    // ─── Create SyncBridge directly (no ApiSessionClient) ──────────────────

    const sessionScopedToken = await resolveSessionScopedSyncNodeToken({
        serverUrl: configuration.serverUrl,
        sessionId: response.id,
        token: {
            raw: credentials.token,
            claims: {
                scope: { type: 'account', userId: 'cli' },
                permissions: ['read', 'write', 'admin'],
            },
        },
    });

    const syncBridge = new SyncBridge({
        serverUrl: configuration.serverUrl,
        token: sessionScopedToken,
        keyMaterial: {
            key: response.encryptionKey,
            variant: response.encryptionVariant,
        },
        sessionId: response.id as SessionID,
    });

    await syncBridge.connect();
    logger.debug('[START] SyncBridge connected');

    // ─── Create RpcHandlerManager and wire to SyncBridge ───────────────────

    const rpcHandlerManager = new RpcHandlerManager({
        scopePrefix: response.id,
        encryptionKey: response.encryptionKey,
        encryptionVariant: response.encryptionVariant,
    });

    // Wire RPC: SyncBridge forwards RPC requests to RpcHandlerManager
    syncBridge.setRpcHandler(async (method: string, params: string) => {
        return rpcHandlerManager.handleRequest({ method, params });
    });

    // Auto-register new RPC methods with SyncNode
    rpcHandlerManager.setRegistrationCallback((prefixedMethod) => {
        syncBridge.registerRpcMethods([prefixedMethod]);
    });

    // Register common RPC handlers (bash, readFile, etc.)
    registerCommonHandlers(rpcHandlerManager, workingDirectory);

    // Register all currently known methods with SyncNode
    syncBridge.registerRpcMethods(rpcHandlerManager.getRegisteredMethods());

    // ─── Push notifications ────────────────────────────────────────────────

    const push = api.push();

    // ─── Start Happy MCP server ────────────────────────────────────────────

    // The Session class owns Claude transcript forwarding, but isn't created
    // until loop(). Defer the MCP server callback until currentSession exists.
    let currentSession: Session | null = null;

    const happyServer = await startHappyServer({
        sessionId: response.id,
        sendClaudeMessage: (body) => {
            if (currentSession) {
                currentSession.sendClaudeMessage(body);
            } else {
                logger.debug('[happyMCP] Session not yet ready, dropping message');
            }
        },
    });
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            syncBridge.updateMetadata((currentMetadata: any) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

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
    syncBridge.updateAgentState((currentState: any) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));

    // Forward user messages from the app to the queue via SyncBridge
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel = options.model;
    let currentFallbackModel: string | undefined = undefined;
    let currentCustomSystemPrompt: string | undefined = undefined;
    let currentAppendSystemPrompt: string | undefined = undefined;
    let currentAllowedTools: string[] | undefined = undefined;
    let currentDisallowedTools: string[] | undefined = undefined;

    const getCurrentEnhancedMode = (): EnhancedMode => ({
        permissionMode: currentPermissionMode || 'default',
        model: currentModel,
        fallbackModel: currentFallbackModel,
        customSystemPrompt: currentCustomSystemPrompt,
        appendSystemPrompt: currentAppendSystemPrompt,
        allowedTools: currentAllowedTools,
        disallowedTools: currentDisallowedTools,
    });

    syncBridge.onRuntimeConfigChange((change) => {
        if (change.permissionMode) {
            currentPermissionMode = applySandboxPermissionPolicy(change.permissionMode as PermissionMode, sandboxEnabled);
        }
        if (Object.prototype.hasOwnProperty.call(change, 'model')) {
            currentModel = change.model || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'fallbackModel')) {
            currentFallbackModel = change.fallbackModel || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'customSystemPrompt')) {
            currentCustomSystemPrompt = change.customSystemPrompt || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'appendSystemPrompt')) {
            currentAppendSystemPrompt = change.appendSystemPrompt || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'allowedTools')) {
            currentAllowedTools = change.allowedTools || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(change, 'disallowedTools')) {
            currentDisallowedTools = change.disallowedTools || undefined;
        }
    });

    syncBridge.onUserMessage((message) => {
        const text = getUserMessageText(message);
        if (!text) return;

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(text);

        const enhancedMode = getCurrentEnhancedMode();

        if (specialCommand.type === 'compact' || specialCommand.type === 'clear') {
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || text, enhancedMode);
            return;
        }

        messageQueue.push(text, enhancedMode);
        logger.debug('User message pushed to queue via SyncBridge');
    });

    syncBridge.onQuestionAnswer((answer) => {
        currentSession?.unblockToolWithAnswers(answer.questionId, answer.answers);

        const answerText = answer.answers
            .map(group => group.join(', ').trim())
            .filter(text => text.length > 0)
            .join('\n');

        if (!answerText) {
            logger.debug('Received empty question answer via SyncBridge');
            return;
        }

        messageQueue.push(answerText, getCurrentEnhancedMode());
        logger.debug('Question answer pushed to queue via SyncBridge');
    });

    // Setup signal handlers for graceful shutdown
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

        try {
            // Update lifecycle state to archived before closing
            syncBridge.updateMetadata((currentMetadata: any) => ({
                ...currentMetadata,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            }));

            // Cleanup session resources (intervals, callbacks)
            currentSession?.cleanup();

            // Send session death message
            syncBridge.sendSessionDeath();
            await syncBridge.flush();
            syncBridge.disconnect();

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

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

    registerKillSessionHandler(rpcHandlerManager, cleanup);

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: initialPermissionMode,
        startingMode: options.startingMode,
        messageQueue,
        syncBridge,
        rpcHandlerManager,
        push,
        hapSessionId: response.id,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            syncBridge.updateAgentState((currentState: any) => ({
                ...currentState,
                controlledByUser: newMode === 'local',
                lastEvent: { type: 'switch', mode: newMode, time: Date.now() },
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback and Happy MCP server
            currentSession = sessionInstance;
        },
        mcpServers: {
            'happy': {
                type: 'http' as const,
                url: happyServer.url,
            }
        },
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        sandboxConfig,
        hookSettingsPath,
        jsRuntime: options.jsRuntime
    });

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    syncBridge.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await syncBridge.flush();

    // Close SyncBridge
    logger.debug('Closing SyncBridge...');
    syncBridge.disconnect();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}

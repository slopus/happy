import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { loop } from '@/claude/loop';
import os from 'node:os';
import { AgentState, Metadata } from '@/api/types';
import type { OnAssistantResultCallback } from '@/ui/messageFormatter';
// @ts-ignore
import packageJson from '../../package.json';
import { registerHandlers } from '@/api/handlers';
import { readSettings } from '@/persistence/persistence';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '@/claude/sdk/prompts';
import { createSessionScanner } from '@/claude/utils/sessionScanner';

export interface StartOptions {
    model?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    daemonSpawn?: boolean
}

export async function start(credentials: { secret: Uint8Array, token: string }, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Validate daemon spawn requirements
    if (options.daemonSpawn && options.startingMode === 'local') {
        logger.debug('Daemon spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
    }

    // Create session service
    const api = new ApiClient(credentials.token, credentials.secret);

    // Create a new session
    let state: AgentState = {};
    const settings = await readSettings() || { onboardingCompleted: false };
    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: settings.machineId
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);

    // Output session ID for daemon to parse when spawned with --daemon-spawn
    if (options.daemonSpawn) {
        console.log(`daemon:sessionIdCreated:${response.id}`);
    }

    // Create realtime session
    const session = api.session(response);
    const pushClient = api.push();

    // We should recieve updates when state changes immediately
    // If we have not recieved an update - that means session is disconnected
    // Either it was closed by user or the computer is offline
    let thinking = false;
    let mode: 'local' | 'remote' = 'local';
    let pingInterval = setInterval(() => {
        session.keepAlive(thinking, mode);
    }, 2000);


    // Print log file path
    const logPath = await logger.logFilePathPromise;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Import MessageQueue2 and create message queue
    const { MessageQueue2 } = await import('@/utils/MessageQueue2');
    type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    const messageQueue = new MessageQueue2<PermissionMode>(
        mode => mode  // Simple string hasher since modes are already strings
    );

    // Start MCP permission server
    let requests = new Map<string, (response: { approved: boolean, reason?: string }) => void>();
    let toolCallResolver: ((name: string, args: any) => string | null) | null = null;

    // Create session scanner
    const sessionScanner = createSessionScanner({
        workingDirectory: workingDirectory,
        onMessage: (message) => {
            session.sendClaudeSessionMessage(message);
        }
    });

    // Register all RPC handlers
    registerHandlers(session);

    // Forward messages to the queue
    let currentPermissionMode = options.permissionMode;
    session.onUserMessage((message) => {
        sessionScanner.onRemoteUserMessageForDeduplication(message.content.text);

        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);

            } else {
                logger.debug(`[loop] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Push with resolved permission mode
        messageQueue.push(message.content.text, messagePermissionMode || 'default');
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        startingMode: options.startingMode,
        messageQueue,
        sessionScanner,
        api,
        onModeChange: (newMode) => {
            mode = newMode;
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.keepAlive(thinking, mode);

            // If switching from remote to local, clear all pending permission requests
            if (newMode === 'local') {
                logger.debug('Switching to local mode - clearing pending permission requests');

                // Clear tool call resolver since we're switching to local mode
                toolCallResolver = null;

                // Reject all pending permission requests
                for (const [id, resolve] of requests) {
                    logger.debug(`Rejecting pending permission request: ${id}`);
                    resolve({ approved: false, reason: 'Session switched to local mode' });
                }
                requests.clear();

                // Move all pending requests to completedRequests with canceled status
                session.updateAgentState((currentState) => {
                    const pendingRequests = currentState.requests || {};
                    const completedRequests = { ...currentState.completedRequests };

                    // Move each pending request to completed with canceled status
                    for (const [id, request] of Object.entries(pendingRequests)) {
                        completedRequests[id] = {
                            ...request,
                            completedAt: Date.now(),
                            status: 'canceled',
                            reason: 'Session switched to local mode'
                        };
                    }

                    return {
                        ...currentState,
                        controlledByUser: true,
                        requests: {}, // Clear all pending requests
                        completedRequests
                    };
                });
            } else {
                // Remote mode
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: false
                }));
            }
        },
        mcpServers: {},
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        onThinkingChange: (newThinking) => {
            thinking = newThinking;
            session.keepAlive(thinking, mode);
        },
        onToolCallResolver: (resolver) => {
            toolCallResolver = resolver;
        },
    });

    clearInterval(pingInterval);

    // NOTE: Shut down as fast as possible to provide 0 claude overhead
    // Do not handle shutdown gracefully, just exit
    let _gracefulShutdown = async () => {
        // Send session death message
        session.sendSessionDeath();

        // Wait for socket to flush
        logger.debug('Waiting for socket to flush...');
        await session.flush();

        // Close session
        logger.debug('Closing session...');
        await session.close();
    }

    // Exit
    process.exit(0);
}
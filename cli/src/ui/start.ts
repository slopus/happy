import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { loop } from '@/claude/loop';
import os from 'node:os';
import { AgentState, Metadata } from '@/api/types';
import { startPermissionServerV2 } from '@/claude/mcp/startPermissionServerV2';
import type { OnAssistantResultCallback } from '@/ui/messageFormatter';
import { InterruptController } from '@/claude/InterruptController';
// @ts-ignore
import packageJson from '../../package.json';
import { registerHandlers } from '@/api/handlers';
import { startClaudeActivityTracker } from '@/claude/claudeActivityTracker';
import { readSettings } from '@/persistence/persistence';

export interface StartOptions {
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
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

    // Prepare proxy
    const activityTracker = await startClaudeActivityTracker((newThinking) => {
        thinking = newThinking;
        session.keepAlive(thinking, mode);
    });
    process.env.ANTHROPIC_BASE_URL = activityTracker.proxyUrl;

    // Print log file path
    const logPath = await logger.logFilePathPromise;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Create interrupt controller
    const interruptController = new InterruptController();

    // Start MCP permission server
    let requests = new Map<string, (response: { approved: boolean, reason?: string }) => void>();
    const permissionServer = await startPermissionServerV2(async (request) => {
        const id = randomUUID();
        let promise = new Promise<{ approved: boolean, reason?: string }>((resolve) => { requests.set(id, resolve); });
        let timeout = setTimeout(async () => {
            // Interrupt claude execution on permission timeout
            logger.debug('Permission timeout - attempting to interrupt Claude');
            const interrupted = await interruptController.interrupt();
            if (interrupted) {
                logger.debug('Claude interrupted successfully');
            }

            // Delete callback we are awaiting on
            requests.delete(id);

            // Move the permission request to completedRequests with canceled status
            session.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;

                let r = { ...currentState.requests };
                delete r[id];

                return ({
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: 'canceled',
                            reason: 'Timeout'
                        }
                    }
                });
            });
        }, 1000 * 60 * 4.5) // 4.5 minutes, 30 seconds before max timeout
        logger.debug('Permission request' + id + ' ' + JSON.stringify(request));

        // Send push notification for permission request
        try {
            await pushClient.sendToAllDevices(
                'Permission Request',
                `Claude wants to use ${request.name}`,
                {
                    sessionId: response.id,
                    requestId: id,
                    tool: request.name,
                    type: 'permission_request'
                }
            );
            logger.debug('Push notification sent for permission request');
        } catch (error) {
            logger.debug('Failed to send push notification:', error);
        }

        session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: request.name,
                    arguments: request.arguments,
                    createdAt: Date.now()
                }
            }
        }));

        // Clear timeout when permission is resolved
        promise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

        return promise;
    });

    // Register all RPC handlers
    registerHandlers(session, interruptController, { requests });

    // Notify mobile client when in remote mode & assistant finished
    const onAssistantResult: OnAssistantResultCallback = async (result) => {
        try {
            // Extract summary or create a default message
            const summary = 'result' in result && result.result
                ? result.result.substring(0, 100) + (result.result.length > 100 ? '...' : '')
                : '';

            await pushClient.sendToAllDevices(
                'Your move :D',
                summary,
                {
                    sessionId: response.id,
                    type: 'assistant_result',
                    turns: result.num_turns,
                    duration_ms: result.duration_ms,
                    cost_usd: result.total_cost_usd
                }
            );
            logger.debug('Push notification sent: Assistant result');
        } catch (error) {
            logger.debug('Failed to send assistant result push notification:', error);
        }
    };

    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        startingMode: options.startingMode,
        onModeChange: (newMode) => {
            mode = newMode;
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.keepAlive(thinking, mode);

            // If switching from remote to local, clear all pending permission requests
            if (newMode === 'local') {
                logger.debug('Switching to local mode - clearing pending permission requests');

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
        onProcessStart: (processMode) => {
            logger.debug(`[Process Lifecycle] Starting ${processMode} mode`);

            // Reset activity tracker when starting any process
            activityTracker.reset();

            // Clear permission requests when starting local mode
            logger.debug('Starting process - clearing any stale permission requests');
            for (const [id, resolve] of requests) {
                logger.debug(`Rejecting stale permission request: ${id}`);
                resolve({ approved: false, reason: 'Process restarted' });
            }
            requests.clear();
        },
        onProcessStop: (processMode) => {
            logger.debug(`[Process Lifecycle] Stopped ${processMode} mode`);

            // Ensure activity tracker is reset when any process stops
            activityTracker.reset();

            logger.debug('Stopping process - clearing any stale permission requests');
            for (const [id, resolve] of requests) {
                logger.debug(`Rejecting stale permission request: ${id}`);
                resolve({ approved: false, reason: 'Process restarted' });
            }
            requests.clear();
        },
        mcpServers: {
            'permission': {
                type: 'http' as const,
                url: permissionServer.url,
            }
        },
        permissionPromptToolName: 'mcp__permission__' + permissionServer.toolName,
        session,
        onAssistantResult,
        interruptController,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
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
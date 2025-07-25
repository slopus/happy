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
import { startAnthropicActivityProxy } from '@/claude/proxy/startAnthropicActivityProxy';

export interface StartOptions {
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
    startingMode?: 'interactive' | 'remote'
    shouldStartDaemon?: boolean
}

export async function start(credentials: { secret: Uint8Array, token: string }, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Create session service
    const api = new ApiClient(credentials.token, credentials.secret);

    // Create a new session
    let state: AgentState = {};
    let metadata: Metadata = { path: workingDirectory, host: os.hostname(), version: packageJson.version };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);

    // Create realtime session
    const session = api.session(response);
    const pushClient = api.push();

    // We should recieve updates when state changes immediately
    // If we have not recieved an update - that means session is disconnected
    // Either it was closed by user or the computer is offline
    let thinking = false;
    let pingInterval = setInterval(() => {
        session.keepAlive(thinking);
    }, 2000);

    // Start Anthropic activity monitoring proxy
    const antropicActivityProxy = await startAnthropicActivityProxy(
        (activity) => {
            const newThinking = activity === 'working';
            if (newThinking !== thinking) {
                thinking = newThinking;
                logger.debug(`[PING] Thinking state changed: ${thinking}`);
                session.keepAlive(thinking);
            }
        }
    );

    // Set the proxy URL for both HTTP and HTTPS traffic
    process.env.HTTP_PROXY = antropicActivityProxy.url;
    process.env.HTTPS_PROXY = antropicActivityProxy.url;
    logger.debug(`[AnthropicProxy] Set HTTP_PROXY and HTTPS_PROXY to ${antropicActivityProxy.url}`);
    
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
            logger.info('Permission timeout - attempting to interrupt Claude');
            const interrupted = await interruptController.interrupt();
            if (interrupted) {
                logger.info('Claude interrupted successfully');
            }

            // Delete callback we are awaiting on
            requests.delete(id);

            // Delete the permission request itself from the agent state
            session.updateAgentState((currentState) => {
                let r = { ...currentState.requests };
                delete r[id];
                return ({
                    ...currentState,
                    requests: r,
                });
            });
        }, 1000 * 60 * 4.5) // 4.5 minutes, 30 seconds before max timeout
        logger.info('Permission request' + id + ' ' + JSON.stringify(request));

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
            logger.info('Push notification sent for permission request');
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
                }
            }
        }));
        
        // Clear timeout when permission is resolved
        promise.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));
        
        return promise;
    });
    session.setHandler<{ id: string, approved: boolean, reason?: string }, void>('permission', async (message) => {
        logger.info('Permission response' + JSON.stringify(message));
        const id = message.id;
        const resolve = requests.get(id);
        if (resolve) {
            if (!message.approved) {
                logger.debug('Permission denied, interrupting Claude');
                await interruptController.interrupt();
            }

            resolve({ approved: message.approved, reason: message.reason });
        } else {
            logger.info('Permission request stale, likely timed out')
            return
        }
        session.updateAgentState((currentState) => {
            let r = { ...currentState.requests };
            delete r[id];
            return ({
                ...currentState,
                requests: r,
            });
        });
    });

    session.setHandler<{}, void>('abort', async () => {
        logger.info('Abort request - interrupting Claude');
        await interruptController.interrupt();
    });

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
        mcpServers: {
            'permission': {
                type: 'http' as const,
                url: permissionServer.url,
            }
        },
        permissionPromptToolName: 'mcp__permission__' + permissionServer.toolName,
        session,
        onAssistantResult,
        interruptController
    });

    clearInterval(pingInterval);

    // NOTE: Shut down as fast as possible to provide 0 claude overhead
    // Do not handle shutdown gracefully, just exit
    let _gracefulShutdown = async () => {
        // Send session death message
        session.sendSessionDeath();

        // Wait for socket to flush
        logger.info('Waiting for socket to flush...');
        await session.flush();

        // Close session
        logger.info('Closing session...');
        await session.close();
    }

    // Exit
    if (antropicActivityProxy) {
        logger.info('[AnthropicProxy] Shutting down activity monitoring proxy');
        antropicActivityProxy.cleanup();
    }
    process.exit(0);
}
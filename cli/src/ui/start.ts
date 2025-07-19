import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { loop } from '@/claude/loop';
import os from 'node:os';
import { AgentState, Metadata } from '@/api/types';
import { startPermissionServerV2 } from '@/claude/mcp/startPermissionServerV2';

export interface StartOptions {
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
}

export async function start(credentials: { secret: Uint8Array, token: string }, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Create session service
    const api = new ApiClient(credentials.token, credentials.secret);

    // Create a new session
    let state: AgentState = {};
    let metadata: Metadata = { path: workingDirectory, host: os.hostname() };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.info(`Session created: ${response.id}`);

    // Create realtime session
    const session = api.session(response);

    // Start MCP permission server
    let requests = new Map<string, (response: { approved: boolean, reason?: string }) => void>();
    const permissionServer = await startPermissionServerV2(async (request) => {
        const id = randomUUID();
        let promise = new Promise<{ approved: boolean, reason?: string }>((resolve) => { requests.set(id, resolve); });
        logger.info('Permission request' + id + ' ' + JSON.stringify(request));

        // Send push notification for permission request
        try {
            const pushClient = api.push();
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
        return promise;
    });
    session.setHandler<{ id: string, approved: boolean, reason?: string }, void>('permission', (message) => {
        logger.info('Permission response' + JSON.stringify(message));
        const id = message.id;
        const resolve = requests.get(id);
        if (resolve) {
            resolve({ approved: message.approved, reason: message.reason });
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

    // Session keep alive
    let thinking = false;
    const pingInterval = setInterval(() => {
        session.keepAlive(thinking);
    }, 15000); // Ping every 15 seconds

    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        mcpServers: {
            'permission': {
                type: 'http' as const,
                url: permissionServer.url,
            }
        },
        permissionPromptToolName: 'mcp__permission__' + permissionServer.toolName,
        onThinking: (t) => {
            thinking = t;
            session.keepAlive(t);
        },
        session
    });

    // Handle graceful shutdown
    logger.info('Shutting down...')

    // Stop ping interval
    clearInterval(pingInterval);

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.info('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.info('Closing session...');
    await session.close();

    // Exit
    process.exit(0);
}
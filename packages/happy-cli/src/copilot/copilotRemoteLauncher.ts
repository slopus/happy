/**
 * Copilot Remote Launcher
 * 
 * Runs Copilot CLI in ACP mode for remote control from the Happy mobile app.
 * If a Copilot session ID is available, it passes --resume to maintain
 * session continuity from local mode.
 * 
 * Uses the existing AcpBackend infrastructure.
 * Modeled on claude/claudeRemoteLauncher.ts and agent/acp/runAcp.ts.
 */

import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { CopilotSession, type CopilotMode } from './copilotSession';
import { AcpBackend, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { CopilotTransport } from '@/agent/transport';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { projectPath } from '@/projectPath';
import type { AgentMessage } from '@/agent/core';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { Future } from '@/utils/future';

class CopilotPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
    async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
            this.addPendingRequestToState(toolCallId, toolName, input);
            logger.debug(`[copilotRemote] Permission request for tool: ${toolName} (${toolCallId})`);
        });
    }

    protected getLogPrefix(): string {
        return '[copilotRemote]';
    }
}

/**
 * Run Copilot in ACP remote mode.
 * Returns 'switch' when user wants local mode, 'exit' on termination.
 */
export async function copilotRemoteLauncher(session: CopilotSession): Promise<'switch' | 'exit'> {
    logger.debug('[copilotRemote] Starting remote launcher');

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;
    let abortController = new AbortController();
    const exitFuture = new Future<void>();

    const permissionHandler = new CopilotPermissionHandler(session.client);
    const sessionManager = new AcpSessionManager();

    // Start Happy MCP server
    const happyServer = await startHappyServer(session.client);
    const mcpServers = {
        happy: {
            command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
            args: ['--url', happyServer.url],
        },
    };

    // Build ACP args — include --resume if we have a session ID
    const acpArgs: string[] = ['--acp'];
    if (session.copilotSessionId) {
        acpArgs.push('--resume', session.copilotSessionId);
        logger.debug(`[copilotRemote] Resuming Copilot session: ${session.copilotSessionId}`);
    }

    const backend = new AcpBackend({
        agentName: 'copilot',
        cwd: session.path,
        command: 'copilot',
        args: acpArgs,
        mcpServers,
        permissionHandler,
        transportHandler: new CopilotTransport(),
    });

    let acpSessionId: string | null = null;

    const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
        for (const envelope of envelopes) {
            session.client.sendSessionProtocolMessage(envelope);
        }
    };

    // Handle backend messages → session protocol
    const onBackendMessage = (msg: AgentMessage) => {
        if (msg.type === 'status') {
            const nextThinking = msg.status === 'running';
            if (session.thinking !== nextThinking) {
                session.onThinkingChange(nextThinking);
            }
            if (msg.status === 'error' || msg.status === 'stopped') {
                shouldExit = true;
                session.queue.close();
            }
        }
        sendEnvelopes(sessionManager.mapMessage(msg));
    };

    backend.onMessage(onBackendMessage);

    // Handle user messages from app
    let currentPermissionMode: string | undefined;
    let currentModel: string | null | undefined;

    session.client.onUserMessage((message) => {
        if (typeof message.meta?.permissionMode === 'string') {
            currentPermissionMode = message.meta.permissionMode;
        }
        if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
            currentModel = message.meta.model ?? null;
        }
        if (!message.content.text) {
            return;
        }
        session.queue.push(message.content.text, {
            permissionMode: currentPermissionMode,
            model: currentModel ?? undefined,
        });
    });

    // Handle abort/switch from app
    async function handleAbort() {
        try {
            if (acpSessionId) {
                await backend.cancel(acpSessionId);
            }
            permissionHandler.reset();
            abortController.abort();
        } catch (error) {
            logger.debug('[copilotRemote] Abort failed:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    session.client.rpcHandlerManager.registerHandler('abort', handleAbort);
    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        logger.debug('[copilotRemote] Switch to local requested');
        if (!exitReason) {
            exitReason = 'switch';
        }
        shouldExit = true;
        session.queue.close();
        await handleAbort();
    });

    registerKillSessionHandler(session.client.rpcHandlerManager, async () => {
        shouldExit = true;
        session.queue.close();
        await handleAbort();
    });

    // Handle stdin for switching back to local (any keypress)
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let stdinHandler: ((data: Buffer) => void) | null = null;

    if (hasTTY) {
        console.log('\n  📱 Remote mode — controlling from Happy app');
        console.log('  Press any key to switch back to local mode\n');

        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        stdinHandler = () => {
            if (!exitReason) {
                exitReason = 'switch';
            }
            shouldExit = true;
            session.queue.close();
            handleAbort();
        };
        process.stdin.on('data', stdinHandler);
    }

    try {
        const started = await backend.startSession();
        acpSessionId = started.sessionId;

        // Capture the Copilot session ID for future resume
        if (acpSessionId && !session.copilotSessionId) {
            session.onCopilotSessionFound(acpSessionId);
        }

        // Main message loop
        while (!shouldExit) {
            const waitSignal = abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (shouldExit || !waitSignal.aborted) break;
                continue;
            }

            if (!acpSessionId) {
                throw new Error('ACP session not started');
            }

            sendEnvelopes(sessionManager.startTurn());
            try {
                await backend.sendPrompt(acpSessionId, batch.message);
                // Wait for idle (turn completion handled by idle timeout in AcpBackend)
                await backend.waitForResponseComplete?.();
                sendEnvelopes(sessionManager.endTurn('completed'));
                session.client.sendSessionEvent({ type: 'ready' });
            } catch (error) {
                sendEnvelopes(sessionManager.endTurn('failed'));
                session.client.sendSessionEvent({ type: 'ready' });
                logger.debug(`[copilotRemote] Prompt error: ${error}`);
            }
        }
    } finally {
        // Cleanup
        if (stdinHandler) {
            process.stdin.removeListener('data', stdinHandler);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
        }

        backend.offMessage?.(onBackendMessage);
        await backend.dispose();
        happyServer.stop();

        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        permissionHandler.reset();
    }

    return exitReason || 'exit';
}

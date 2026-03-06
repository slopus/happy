/**
 * Copilot Remote Launcher
 *
 * Runs Copilot via the @github/copilot-sdk for remote control from the Happy mobile app.
 * Uses the SDK's native session resume support to maintain session continuity
 * from local mode (unlike ACP mode which does not support --resume).
 *
 * Event relay uses the same CopilotSessionScanner as local mode — it watches
 * Copilot's events.jsonl file and relays complete events to the app, avoiding
 * the fragmented streaming deltas that the SDK event callbacks produce.
 *
 * Modeled on claude/claudeRemoteLauncher.ts.
 */

import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
import { logger } from '@/ui/logger';
import { CopilotSession as HappyCopilotSession, type CopilotMode } from './copilotSession';
import { CopilotClient, type PermissionRequest, type PermissionRequestResult, type SessionEvent } from '@github/copilot-sdk';
import type { CopilotSessionScanner } from './utils/copilotSessionScanner';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { projectPath } from '@/projectPath';
import { Future } from '@/utils/future';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Permission handler that bridges the Copilot SDK's onPermissionRequest callback
 * to Happy's BasePermissionHandler pattern (pending requests, RPC approval from app).
 */
class SdkPermissionHandler extends BasePermissionHandler {
    /**
     * SDK callback: called by the Copilot SDK when a tool needs permission.
     * Returns a promise that resolves when the user approves/denies via the app.
     */
    handleSdkPermission = async (request: PermissionRequest): Promise<PermissionRequestResult> => {
        const toolCallId = (request.toolCallId as string) || `perm-${Date.now()}`;
        const toolName = request.kind || 'unknown';

        const result = await new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input: request });
            this.addPendingRequestToState(toolCallId, toolName, request);
            logger.debug(`[copilotRemote] Permission request for tool: ${toolName} (${toolCallId})`);
        });

        switch (result.decision) {
            case 'approved':
            case 'approved_for_session':
                return { kind: 'approved' };
            case 'denied':
                return { kind: 'denied-interactively-by-user' };
            case 'abort':
                return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
            default:
                return { kind: 'denied-interactively-by-user' };
        }
    };

    protected getLogPrefix(): string {
        return '[copilotRemote]';
    }
}

/**
 * Run Copilot in SDK-based remote mode.
 * Returns 'switch' when user wants local mode, 'exit' on termination.
 *
 * The scanner is passed in from copilotLoop (same instance used by local mode)
 * so that events.jsonl relay uses the same processedIds set, preventing
 * duplicate events when switching between modes.
 */
export async function copilotRemoteLauncher(session: HappyCopilotSession, scanner: CopilotSessionScanner): Promise<'switch' | 'exit'> {
    logger.debug('[copilotRemote] Starting SDK remote launcher');

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;
    let abortController = new AbortController();
    const exitFuture = new Future<void>();

    const permissionHandler = new SdkPermissionHandler(session.client);

    // Start Happy MCP server
    const happyServer = await startHappyServer(session.client);
    const mcpServers = {
        happy: {
            command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
            args: ['--url', happyServer.url],
            tools: ['*'] as string[],
        },
    };

    // Initialize Copilot SDK client.
    // Suppress Node.js experimental warnings (e.g. node:sqlite) from the CLI subprocess
    // by passing NODE_NO_WARNINGS=1 in the child process environment.
    const client = new CopilotClient({
        cwd: session.path,
        logLevel: 'info',
        useLoggedInUser: true,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    let sdkSession: Awaited<ReturnType<typeof client.createSession>> | null = null;

    // NOTE: Do NOT register session.client.onUserMessage here.
    // The global handler in runCopilot.ts already pushes app messages to session.queue.
    // We just read from the queue in the loop below (same pattern as claudeRemoteLauncher).

    // Handle abort/switch from app
    async function handleAbort() {
        try {
            if (sdkSession) {
                await sdkSession.abort();
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

    // Use the same Ink-based RemoteModeDisplay as Claude for consistent UX.
    // Double-space to switch to local, Ctrl-C to exit.
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: ReturnType<typeof render> | null = null;
    const messageBuffer = new MessageBuffer();

    if (hasTTY) {
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            title: 'Copilot Messages',
            onExit: async () => {
                logger.debug('[copilotRemote] Exit via Ctrl-C');
                if (!exitReason) exitReason = 'exit';
                shouldExit = true;
                session.queue.close();
                await handleAbort();
            },
            onSwitchToLocal: () => {
                logger.debug('[copilotRemote] Switch to local via double-space');
                if (!exitReason) exitReason = 'switch';
                shouldExit = true;
                session.queue.close();
                handleAbort();
            },
        }), { exitOnCtrlC: false, patchConsole: false });

        process.stdin.resume();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.setEncoding('utf8');
    }

    try {
        await client.start();

        // Session config shared between create and resume
        const sessionConfig = {
            streaming: true,
            onPermissionRequest: permissionHandler.handleSdkPermission,
            mcpServers,
            workingDirectory: session.path,
        };

        // Create or resume session.
        // Fall back to createSession if resumeSession fails (e.g. stale ID from
        // local launcher that was never actually used by the Copilot CLI).
        if (session.copilotSessionId) {
            try {
                logger.debug(`[copilotRemote] Resuming Copilot session: ${session.copilotSessionId}`);
                sdkSession = await client.resumeSession(session.copilotSessionId, sessionConfig);
            } catch (err) {
                logger.debug(`[copilotRemote] Resume failed, creating new session: ${err}`);
                sdkSession = await client.createSession(sessionConfig);
                session.onCopilotSessionFound(sdkSession.sessionId);
            }
        } else {
            sdkSession = await client.createSession(sessionConfig);
            session.onCopilotSessionFound(sdkSession.sessionId);
            logger.debug(`[copilotRemote] Created new Copilot session: ${sdkSession.sessionId}`);
        }

        // Use the session scanner to relay events from events.jsonl — same
        // mechanism as local mode. The scanner reads complete events (not
        // streaming deltas) so the app gets properly batched messages.
        // skipExisting=true for resumed sessions, false for new ones.
        const isResume = session.copilotSessionId === sdkSession.sessionId;
        scanner.watchSession(sdkSession.sessionId, isResume);

        // SDK event handlers — used for turn lifecycle (idle/error) and to
        // update the local terminal display via messageBuffer.
        // Content relay to the app is handled by the scanner (events.jsonl).
        let idleResolve: (() => void) | null = null;
        let activeToolCount = 0;

        sdkSession.on('assistant.message_delta', (event: SessionEvent) => {
            const delta = (event as any).data?.deltaContent as string | undefined;
            if (delta) messageBuffer.updateLastMessage(delta, 'assistant');
        });

        sdkSession.on('assistant.reasoning_delta', () => {
            session.onThinkingChange(true);
        });

        sdkSession.on('tool.execution_start', (event: SessionEvent) => {
            session.onThinkingChange(true);
            activeToolCount++;
            const toolName = (event as any).data?.toolName as string | undefined;
            // Update a single status line instead of adding separate messages
            messageBuffer.removeLastMessage('status');
            messageBuffer.addMessage(`⚙️  Running ${toolName || 'tool'}...`, 'status');
        });

        sdkSession.on('tool.execution_complete', () => {
            activeToolCount = Math.max(0, activeToolCount - 1);
            if (activeToolCount === 0) {
                messageBuffer.removeLastMessage('status');
            }
        });

        sdkSession.on('session.idle', () => {
            session.onThinkingChange(false);
            if (idleResolve) {
                idleResolve();
                idleResolve = null;
            }
        });

        sdkSession.on('session.error', (event: SessionEvent) => {
            logger.debug(`[copilotRemote] Session error: ${JSON.stringify(event)}`);
            session.onThinkingChange(false);
            if (idleResolve) {
                idleResolve();
                idleResolve = null;
            }
        });

        // Main message loop
        while (!shouldExit) {
            const waitSignal = abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (shouldExit || !waitSignal.aborted) break;
                continue;
            }

            messageBuffer.addMessage(`> ${batch.message.length > 80 ? batch.message.substring(0, 80) + '…' : batch.message}`, 'user');
            session.onThinkingChange(true);

            try {
                // Create idle promise BEFORE sending to avoid race condition
                const idlePromise = new Promise<void>((resolve) => {
                    idleResolve = resolve;
                });

                messageBuffer.addMessage('', 'assistant');
                await sdkSession.send({ prompt: batch.message });
                await idlePromise;

                session.client.sendSessionEvent({ type: 'ready' });
            } catch (error) {
                session.client.sendSessionEvent({ type: 'ready' });
                logger.debug(`[copilotRemote] Prompt error: ${error}`);
            }
        }
    } finally {
        logger.debug(`[copilotRemote] Cleanup. exitReason=${exitReason}, hasTTY=${hasTTY}`);
        // Cleanup — fully release stdin so the next child process can use it.
        inkInstance?.unmount();
        if (hasTTY && process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (hasTTY) {
            process.stdin.pause();
        }
        // Force exit alternate screen buffer and restore cursor visibility.
        if (hasTTY) {
            process.stdout.write('\x1b[?1049l\x1b[?25h');
        }
        logger.debug('[copilotRemote] Terminal cleared, stdin raw mode off');

        try { if (sdkSession) await sdkSession.destroy(); } catch {}
        try { await client.stop(); } catch {}
        happyServer.stop();

        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        permissionHandler.reset();
    }

    return exitReason || 'exit';
}

import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/backends/claude/ui/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { AbortError, SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/backends/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

type LaunchErrorInfo = {
    asString: string;
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
};

function getLaunchErrorInfo(e: unknown): LaunchErrorInfo {
    let asString = '[unprintable error]';
    try {
        asString = typeof e === 'string' ? e : String(e);
    } catch {
        // Ignore
    }

    if (!e || typeof e !== 'object') {
        return { asString };
    }

    const err = e as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };

    const name = typeof err.name === 'string' ? err.name : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : undefined;
    const stack = typeof err.stack === 'string' ? err.stack : undefined;

    return { asString, name, message, code, stack };
}

function isAbortError(e: unknown): boolean {
    if (e instanceof AbortError) return true;

    if (!e || typeof e !== 'object') {
        return false;
    }

    const err = e as { name?: unknown; code?: unknown };
    if (typeof err.name === 'string' && err.name === 'AbortError') return true;
    if (typeof err.code === 'string' && err.code === 'ABORT_ERR') return true;

    return false;
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        // Ensure we can capture keypresses for the remote-mode UI.
        // Avoid forcing stdin encoding here; Ink (and Node) should handle key decoding safely.
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        await abort();
    }

    async function ensureSessionInfoBeforeSwitch(): Promise<void> {
        const needsSessionId = session.sessionId === null;
        const needsTranscriptPath = session.transcriptPath === null;
        if (!needsSessionId && !needsTranscriptPath) return;

        session.client.sendSessionEvent({
            type: 'message',
            message: needsSessionId
                ? 'Waiting for Claude session to initialize before switching…'
                : 'Waiting for Claude transcript info before switching…',
        });

        await session.waitForSessionFound({
            timeoutMs: 2000,
            requireTranscriptPath: needsTranscriptPath,
        });
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await ensureSessionInfoBeforeSwitch();
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', async (params: any) => {
        // Newer clients send a target mode. Older clients send no params.
        // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
        const to = params && typeof params === 'object' ? (params as any).to : undefined;
        if (to === 'remote') return false;
        await doSwitch();
        return true;
    }); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    function onMessage(message: SDKMessage) {

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            const allowedTools = response.allowedTools ?? response.allowTools;
                            if (allowedTools && allowedTools.length > 0) {
                                permissions.allowedTools = allowedTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
        } | null = null;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null | undefined = undefined;
        let forceNewSession = false;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = forceNewSession || session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                forceNewSession = false;
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    transcriptPath: session.transcriptPath,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
	                    nextMessage: async () => {
	                        if (pending) {
	                            let p = pending;
	                            pending = null;
	                            permissionHandler.handleModeChange(p.mode.permissionMode);
	                            return p;
	                        }

	                        const msg = await waitForMessagesOrPending({
	                            messageQueue: session.queue,
	                            abortSignal: controller.signal,
	                            popPendingMessage: async () => {
	                                // Only materialize pending items when there are no committed transcript messages
	                                // queued locally; committed messages must be processed first.
	                                if (session.queue.size() > 0) return false;
	                                return await session.client.popPendingMessage();
	                            },
	                            waitForMetadataUpdate: (signal) => session.client.waitForMetadataUpdate(signal),
	                        });

	                        // Check if mode has changed
	                        if (msg) {
	                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
	                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        forceNewSession = true;
                        session.clearSessionId();
                    },
                    onReady: () => {
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                            session.api.push().sendToAllDevices(
                                'It\'s ready!',
                                `Claude is waiting for your command`,
                                { sessionId: session.client.sessionId }
                            );
                        }
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                const abortError = isAbortError(e);
                logger.debug('[remote]: launch error', {
                    ...getLaunchErrorInfo(e),
                    abortError,
                });

                if (!exitReason) {
                    if (abortError) {
                        if (controller.signal.aborted) {
                            session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                        }
                        continue;
                    }

                    session.client.sendSessionEvent({ type: 'message', message: `Claude process error: ${formatErrorForUi(e)}` });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
                // Session IDs can change during a remote run (system init / resume / fork / compact).
                // Keep previousSessionId in sync so we don't treat the same session as "new" again
                // on the next outer loop iteration.
                previousSessionId = session.sessionId;
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }

        // Give Ink a brief moment to release stdin/tty state, then drain any buffered input
        // (e.g. “double space” spam) so it doesn't leak into the next interactive process.
        await cleanupStdinAfterInk({ stdin: process.stdin as any, drainMs: 75 });

        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}

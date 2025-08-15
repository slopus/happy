import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { startPermissionResolver } from "./utils/startPermissionResolver";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { createSessionScanner } from "./utils/sessionScanner";

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    console.clear();
    let inkInstance = render(React.createElement(RemoteModeDisplay, {
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
    process.stdin.resume();
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding("utf8");

    // Start the scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            if (message.type === 'summary') {
                session.client.sendClaudeSessionMessage(message);
            }
        }
    });

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

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.setHandler('abort', doAbort); // When abort clicked
    session.client.setHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission server
    const permissions = await startPermissionResolver(session);

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissions.responses);

    // Handle messages
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    function onMessage(message: SDKMessage) {

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission server for tool id resolving
        permissions.onMessage(message);

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Filter out system messages - they're usually not sent to logs
            if (logMessage.type !== 'system') {
                session.client.sendClaudeSessionMessage(logMessage);
            }
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            session.client.sendClaudeSessionMessage(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        while (!exitReason) {

            // Fetch next message
            logger.debug('[remote]: fetch next message');
            abortController = new AbortController();
            abortFuture = new Future<void>();
            const messageData = await session.queue.waitForMessagesAndGetAsString(abortController.signal);
            if (!messageData || abortController.signal.aborted) {
                logger.debug('[remote]: fetch next message done: no message or aborted');
                abortFuture?.resolve(undefined);
                if (exitReason) {
                    return exitReason;
                } else {
                    continue;
                }
            }
            logger.debug('[remote]: fetch next message done: message received');
            abortFuture?.resolve(undefined);
            abortFuture = null;
            abortController = null;

            // Run claude
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');
            messageBuffer.addMessage('Starting new Claude session...', 'status');
            abortController = new AbortController();
            abortFuture = new Future<void>();
            permissions.reset(); // Reset permissions before starting new session
            sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
            try {
                await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    responses: permissions.responses,
                    mcpServers: {
                        ...session.mcpServers,
                        permission: {
                            type: 'http' as const,
                            url: permissions.server.url,
                        }
                    },
                    permissionPromptToolName: 'mcp__permission__' + permissions.server.toolName,
                    permissionMode: messageData.mode.permissionMode,
                    model: messageData.mode.model,
                    fallbackModel: messageData.mode.fallbackModel,
                    customSystemPrompt: messageData.mode.customSystemPrompt,
                    appendSystemPrompt: messageData.mode.appendSystemPrompt,
                    allowedTools: messageData.mode.allowedTools,
                    disallowedTools: messageData.mode.disallowedTools,
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                        scanner.onNewSession(sessionId);
                    },
                    onThinkingChange: session.onThinkingChange,
                    message: messageData.message,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    signal: abortController.signal,
                });
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                }
            } finally {

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissions.reset();
            }
        }
    } finally {

        // Stop permission server
        permissions.server.stop();

        // Reset Terminal
        process.stdin.off('data', abort);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        inkInstance.unmount();
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }

        // Stop the scanner
        await scanner.cleanup();
    }

    return exitReason || 'exit';
}
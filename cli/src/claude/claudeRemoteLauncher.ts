import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { startPermissionResolver } from "./utils/startPermissionResolver";
import { Future } from "@/utils/future";
import { SDKMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";

export async function claudeRemoteLauncher(session: Session) {

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    console.clear();
    let inkInstance = render(React.createElement(RemoteModeDisplay, { messageBuffer, logPath: process.env.DEBUG ? session.logPath : undefined }), {
        exitOnCtrlC: false,
        patchConsole: false
    });
    process.stdin.resume();
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding("utf8");

    // Handle abort
    let exitReason: 'switch' | null = null as 'switch' | null;
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
    process.stdin.on('data', doSwitch); // When any key is pressed

    // Create permission server
    const permissions = await startPermissionResolver(session);

    // Handle messages
    function onMessage(message: SDKMessage) {
        formatClaudeMessageForInk(message, messageBuffer);
        permissions.onMessage(message);
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
            try {
                await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    mcpServers: {
                        ...session.mcpServers,
                        permission: {
                            type: 'http' as const,
                            url: permissions.server.url,
                        }
                    },
                    permissionPromptToolName: 'mcp__permission__' + permissions.server.toolName,
                    permissionMode: messageData.mode,
                    onSessionFound: session.onSessionFound,
                    onThinkingChange: session.onThinkingChange,
                    message: messageData.message,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    signal: abortController.signal,
                });
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                }
            } finally {
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
    }

    return exitReason || 'switch';
}
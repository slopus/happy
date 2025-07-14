/**
 * Claude loop - processes user messages in batches
 * 
 * This module implements the main processing loop that:
 * 1. Waits for user messages from the session
 * 2. Batches messages received within a short time window
 * 3. Processes them with Claude
 * 4. Sends responses back through the session
 */

import { ApiSessionClient } from "@/api/apiSession";
import { UserMessage } from "@/api/types";
import { claude } from "./claude";

export function startClaudeLoop(opts: {
    path: string
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan',
    onThinking?: (thinking: boolean) => void
}, session: ApiSessionClient) {

    let exiting = false;
    const messageQueue: UserMessage[] = [];
    let messageResolve: (() => void) | null = null;
    let sessionId: string | undefined;
    let promise = (async () => {

        // Handle incoming messages
        session.onUserMessage((message) => {
            messageQueue.push(message);
            // Wake up the loop if it's waiting
            if (messageResolve) {
                messageResolve();
                messageResolve = null;
            }
        });

        while (!exiting) {
            if (messageQueue.length > 0) {
                const message = messageQueue.shift();
                if (message) {
                    opts.onThinking?.(true);
                    for await (const output of claude({
                        command: message.content.text,
                        workingDirectory: opts.path,
                        model: opts.model,
                        permissionMode: opts.permissionMode,
                        sessionId: sessionId,
                    })) {

                        // Handle exit
                        if (output.type === 'exit') {
                            if (output.code !== 0 || output.code === undefined) {
                                session.sendMessage({
                                    content: {
                                        type: 'error',
                                        error: output.error,
                                        code: output.code,
                                    },
                                    role: 'assistant',
                                });
                            }
                            break;
                        }

                        // Handle JSON output
                        if (output.type === 'json') {
                            session.sendMessage({
                                data: output.data,
                                type: 'output',
                            });
                        }

                        // Handle system messages
                        if (output.type === 'json' && output.data.type === 'system' && output.data.subtype === 'init') {
                            sessionId = output.data.sessionId;
                        }
                    }
                    opts.onThinking?.(false);
                }
            }

            // Wait for next message
            await new Promise<void>((resolve) => {
                messageResolve = resolve;
            });
        }
    })();

    return async () => {
        exiting = true;
        // Wake up the loop if it's waiting
        if (messageResolve) {
            messageResolve();
        }
        await promise;
    };
}
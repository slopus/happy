import { ApiSessionClient } from "@/api/apiSession"
import { claudeRemote } from "./claudeRemote"
import { claudeLocal } from "./claudeLocal"
import { MessageQueue } from "@/utils/MessageQueue"
import { RawJSONLines } from "./types"
import { logger } from "@/ui/logger"
import { createSessionScanner } from "./scanner/sessionScanner"
import type { OnAssistantResultCallback } from "@/ui/messageFormatter"
import type { InterruptController } from "./InterruptController"

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
    mcpServers?: Record<string, any>
    permissionPromptToolName?: string
    onThinking?: (thinking: boolean) => void,
    session: ApiSessionClient
    onAssistantResult?: OnAssistantResultCallback
    interruptController?: InterruptController
}

/*
  When switching between modes or resuming sessions, we maintain a complete
  conversation history to properly deduplicate messages. This is necessary
  because Claude creates new session files when resuming with --resume,
  duplicating the conversation history in the new file.
  
  The new watcher uses full file reading and message deduplication to handle
  this correctly.
*/

export async function loop(opts: LoopOptions) {
    let mode: 'interactive' | 'remote' = 'interactive' as 'interactive' | 'remote';
    let currentMessageQueue: MessageQueue = new MessageQueue();
    let sessionId: string | null = null;
    let onMessage: (() => void) | null = null;

    /*
        NOTE: User messages that come to us from the remote session, will be
        written by claude to session file, and re-emitted to us.
        We cannot pass any stable ID to claude for the message.

        Invariant:
        For each incoming user message, we expect to see it come out of the session
        scanner exactly once.

        Why can't we simply ignore messages with the same content we have seen?
        - Remote User: Run 'yarn build'
        - Scanner emits 'user: Run 'yarn build''
        - [switch to local mode]
        - Local user (through claude terminal session): Run 'yarn build'
        - Scanner emits 'user: Run 'yarn build''
        
        So if we were to ignore messages with the same content we have seen, we would not emit this message to the server. The counter solution addresses this.
    */
    let seenRemoteUserMessageCounters: Map<string, number> = new Map();

    // Handle user messages
    opts.session.onUserMessage((message) => {
        logger.debugLargeJson('User message pushed to queue:', message)
        currentMessageQueue.push(message.content.text);

        // Increment the counter for this remote user message
        seenRemoteUserMessageCounters.set(message.content.text, (seenRemoteUserMessageCounters.get(message.content.text) || 0) + 1);

        if (onMessage) {
            onMessage();
        }
    });


    const sessionScanner = createSessionScanner({
        workingDirectory: opts.path,
        onMessage: (message) => {
            if (message.type === 'user' && typeof message.message.content === 'string') {
                const currentCounter = seenRemoteUserMessageCounters.get(message.message.content);
                if (currentCounter && currentCounter > 0) {
                    // We have already seen this message from the remote session
                    // Lets decrement the counter & skip
                    seenRemoteUserMessageCounters.set(message.message.content, currentCounter - 1);
                    return;
                }
            }
            opts.session.sendClaudeSessionMessage(message);
        }
    });


    let onSessionFound = (newSessionId: string) => {
        sessionId = newSessionId;
        sessionScanner.onNewSession(newSessionId);
    }

    while (true) {
        // Switch to remote mode if there are messages waiting
        if (currentMessageQueue.size() > 0) {
            mode = 'remote';
            continue;
        }

        // Start local mode
        if (mode === 'interactive') {
            let abortedOutside = false;
            const interactiveAbortController = new AbortController();
            opts.session.setHandler('switch', () => {
                if (!interactiveAbortController.signal.aborted) {
                    abortedOutside = true;
                    mode = 'remote';
                    interactiveAbortController.abort();
                }
            });
            onMessage = () => {
                if (!interactiveAbortController.signal.aborted) {
                    abortedOutside = true;
                    mode = 'remote';
                    interactiveAbortController.abort();
                }
                onMessage = null;
            };
            await claudeLocal({
                path: opts.path,
                sessionId: sessionId,
                onSessionFound: onSessionFound,
                abort: interactiveAbortController.signal,
            });
            onMessage = null;
            if (!abortedOutside) {
                return;
            }
            if (mode !== 'interactive') {
                console.log('Switching to remote mode...');
            }
        }

        // Start remote mode
        if (mode === 'remote') {
            logger.debug('Starting ' + sessionId);
            const remoteAbortController = new AbortController();
            
            // Use the current queue for this session
            opts.session.setHandler('abort', () => {
                if (!remoteAbortController.signal.aborted) {
                    remoteAbortController.abort();
                }
            });
            const abortHandler = () => {
                if (!remoteAbortController.signal.aborted) {
                    mode = 'interactive';
                    remoteAbortController.abort();
                }
                process.stdin.setRawMode(false);
            };
            process.stdin.resume();
            process.stdin.setRawMode(true);
            process.stdin.setEncoding("utf8");
            process.stdin.on('data', abortHandler);
            try {
                logger.debug(`Starting claudeRemote with messages: ${currentMessageQueue.size()}`);
                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    mcpServers: opts.mcpServers,
                    permissionPromptToolName: opts.permissionPromptToolName,
                    onSessionFound: onSessionFound,
                    messages: currentMessageQueue,
                    onAssistantResult: opts.onAssistantResult,
                    interruptController: opts.interruptController
                });
            } finally {
                process.stdin.off('data', abortHandler);
                process.stdin.setRawMode(false);
                // Once we are done with this session, release the queue
                // otherwise an old watcher somehow maintains reference to it
                // and consumes our new message
                currentMessageQueue.close()
                currentMessageQueue = new MessageQueue();
            }
            if (mode !== 'remote') {
                console.log('Switching back to good old claude...');
            }
        }
    }
}

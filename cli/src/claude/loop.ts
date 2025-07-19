import { ApiSessionClient } from "@/api/apiSession"
import { claudeRemote } from "./claudeRemote"
import { claudeLocal } from "./claudeLocal"
import { MessageQueue } from "@/utils/MessageQueue"
import { RawJSONLines } from "./types"
import { logger } from "@/ui/logger"
import { createSessionScanner } from "./scanner/sessionScanner"

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
    mcpServers?: Record<string, any>
    permissionPromptToolName?: string
    onThinking?: (thinking: boolean) => void,
    session: ApiSessionClient
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
    // NOTE: exited & abortController are currently unused
    let exited = false;
    let abortController: AbortController | null = null;
    let mode: 'interactive' | 'remote' = 'interactive' as 'interactive' | 'remote';
    let currentMessageQueue: MessageQueue = new MessageQueue();
    let seenRemoteUserMessageContents: Set<string> = new Set();
    let sessionId: string | null = null;
    let conversationHistory: RawJSONLines[] = [];
    let onMessage: (() => void) | null = null;

    // Handle user messages
    opts.session.onUserMessage((message) => {
        logger.debugLargeJson('User message pushed to queue:', message)
        currentMessageQueue.push(message.content.text);
        seenRemoteUserMessageContents.add(message.content.text);
        
        if (onMessage) {
            onMessage();
        } else {
            console.log('[WARNING] No onMessage handler');
        }
    });


    const sessionScanner = createSessionScanner({
        workingDirectory: opts.path,
        onMessage: (message) => {
            opts.session.sendClaudeSessionMessage(message);
        }
    });


    let onSessionFound = (sessionId: string) => {
        sessionId = sessionId;
        sessionScanner.onNewSession(sessionId);
    }

    while (!exited) {
        // Switch to remote mode if there are messages waiting
        if (currentMessageQueue.size() > 0) {
            mode = 'remote';
            continue;
        }

        // Start local mode
        if (mode === 'interactive') {
            let abortedOutside = false;
            const interactiveAbortController = new AbortController();
            abortController = interactiveAbortController;
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
            console.log('Starting ' + sessionId);
            const remoteAbortController = new AbortController();
            abortController = remoteAbortController;
            
            // Use the current queue for this session
            const queueForThisSession = currentMessageQueue;
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
                logger.debug(`Starting claudeRemote with messages: ${queueForThisSession.size()}`);
                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    mcpServers: opts.mcpServers,
                    permissionPromptToolName: opts.permissionPromptToolName,
                    onSessionFound: onSessionFound,
                    messages: queueForThisSession,
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
            if (mode !== 'remote' && !exited) {
                console.log('Switching to interactive mode...');
            }
        }
    }
}

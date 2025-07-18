import { ApiSessionClient } from "@/api/apiSession"
import { claudeRemote } from "./claudeRemote"
import { claudeLocal } from "./claudeLocal"
import { MessageQueue } from "@/utils/MessageQueue"
import { getProjectDirForDirectory, getSessionFilePath, watchMostRecentSession, watchSessionFile } from "./watcher"
import { join } from "path"
import { logger } from "@/ui/logger"

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
  When switching between modes, we need to keep track of the last known 
  message to prevent us from reading the same message twice after
  resuming a session (remember claude clones the session file).

  During this clone:
  - The top level uuid does not survive - fresh one for each line
  - The message.id does survive - but user messages do not have one
  - timestamp does survive

  It is impossible to switch back and forth so fast that the timestamp is the same.
  So we will use it to seek the file until we find the last known message.
*/

export async function loop(opts: LoopOptions) {
    // NOTE: exited & abortController are currently unused
    let exited = false;
    let abortController: AbortController | null = null;
    let mode: 'interactive' | 'remote' = 'interactive' as 'interactive' | 'remote';
    let queue = new MessageQueue();
    let sessionId: string | null = null;
    let lastKnownMessageTimestamp: string | undefined = undefined;
    let onMessage: (() => void) | null = null;

    // Handle user messages
    opts.session.onUserMessage((message) => {
        logger.debugLargeJson('User message pushed to queue:', message)
        queue.push(message.content.text);
        if (onMessage) {
            onMessage();
        } else {
            console.log('[WARNING] No onMessage handler');
        }
    });

    let currentWatcherAbortController: AbortController | null = null;
    // NOTE: This function might get called multiple times for a single session
    let startWatchingSessionForMessages = async (
        newSessionId: string
    ) => {
        currentWatcherAbortController?.abort();
        currentWatcherAbortController = new AbortController();

        sessionId = newSessionId;
        for await (const message of watchMostRecentSession(opts.path, sessionId, currentWatcherAbortController, lastKnownMessageTimestamp)) {
            // NOTE: We want to skip messages from user in remote mode
            // they were all sent by us from remote, no need to re-send
            // Better solution would be to:
            lastKnownMessageTimestamp = message.timestamp;
            if (mode === 'remote' && message.type === 'user') {
                console.log('Skipping sending user message to server in remote mode');
                continue;
            }
            opts.session.sendClaudeSessionMessage(message);
        }
    }

    while (!exited) {

        // Switch to remote mode if there are messages in queue
        if (queue.size() > 0) {
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
                onSessionFound: startWatchingSessionForMessages,
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
                logger.debug(`Starting claudeRemote with messages: ${queue.size()}`);
                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    mcpServers: opts.mcpServers,
                    permissionPromptToolName: opts.permissionPromptToolName,
                    onSessionFound: startWatchingSessionForMessages,
                    messages: queue,
                });
            } finally {
                process.stdin.off('data', abortHandler);
            }
            if (mode !== 'remote' && !exited) {
                console.log('Switching to interactive mode...');
            }
        }
    }
}

import { ApiSessionClient } from "@/api/apiSession"
import { claudeRemote } from "./claudeRemote"
import { claudeLocal } from "./claudeLocal"
import { MessageQueue } from "@/utils/MessageQueue"

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
    mcpServers?: Record<string, any>
    permissionPromptToolName?: string
    onThinking?: (thinking: boolean) => void,
    session: ApiSessionClient
}

export async function loop(opts: LoopOptions) {
    let exited = false;
    let abortController: AbortController | null = null;
    let mode: 'interactive' | 'remote' = 'interactive' as 'interactive' | 'remote';
    let queue = new MessageQueue();
    let sessionId: string | null = null;
    let onMessage: (() => void) | null = null;

    // Handle user messages
    opts.session.onUserMessage((message) => {
        queue.push(message.content.text);
        if (onMessage) {
            onMessage();
        }
    });

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
                sessionId: null,
                onSessionFound: (id) => {
                    sessionId = id;
                },
                abort: interactiveAbortController.signal,
            });
            onMessage = null;
            if (!abortedOutside) {
                return;
            }
            if (mode !== 'interactive' && !exited) {
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
                console.log('abortHandler');
                if (!remoteAbortController.signal.aborted) {
                    console.log('aborting');
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
                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    onSessionFound: (id) => {
                        sessionId = id;
                    },
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
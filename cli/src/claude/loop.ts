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
    onThinking?: (thinking: boolean) => void
}

export function startClaudeLoop(opts: LoopOptions, session: ApiSessionClient) {
    let exited = false;
    let abortController: AbortController | null = null;
    let mode: 'interactive' | 'remote' = 'interactive' as 'interactive' | 'remote';
    let queue = new MessageQueue();
    session.onUserMessage((message) => {
        queue.push(message.content.text);
    });
    let promise = (async () => {
        let sessionId: string | null = null;
        while (!exited) {

            // Start local mode
            if (mode === 'interactive') {
                let abortedOutside = false;
                const interactiveAbortController = new AbortController();
                abortController = interactiveAbortController;
                session.addHandler('switch', () => {
                    abortedOutside = true;
                    mode = 'remote';
                    interactiveAbortController.abort();
                });
                await claudeLocal({
                    path: opts.path,
                    sessionId: null,
                    onSessionFound: (id) => {
                        sessionId = id;
                    },
                    abort: interactiveAbortController.signal,
                });
                if (!abortedOutside) {
                    return;
                }
                if (mode !== 'interactive' && !exited) {
                    console.log('Switching to remote mode...');
                }
            }

            // Start remote mode
            if (mode === 'remote') {
                const remoteAbortController = new AbortController();
                abortController = remoteAbortController;
                session.addHandler('abort', () => {
                    remoteAbortController.abort();
                });
                process.stdin.once('data', () => {
                    mode = 'interactive';
                    remoteAbortController.abort();
                });
                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    onSessionFound: (id) => {
                        sessionId = id;
                    },
                    messages: queue,
                });
                if (mode !== 'remote' && !exited) {
                    console.log('Switching to interactive mode...');
                }
            }
        }
    })();

    return async () => {
        exited = true;
        abortController?.abort();
        await promise
    }
}
import { query, type Options, type SDKUserMessage, type SDKMessage, AbortError } from '@anthropic-ai/claude-code'
import { formatClaudeMessage, printDivider, type OnAssistantResultCallback } from '@/ui/messageFormatter'
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';
import { mkdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';

export async function claudeRemote(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    onSessionFound: (id: string) => void,
    messages: AsyncIterable<SDKUserMessage>,
    onAssistantResult?: OnAssistantResultCallback
}) {
    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Prepare SDK options
    const abortController = new AbortController();
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
        executable: 'node',
        abortController: abortController,
    }

    // Query Claude
    let aborted = false;
    let response: AsyncGenerator<SDKMessage>;
    opts.abort.addEventListener('abort', () => {
        if (!aborted) {
            aborted = true;
            if (response) {
                (async () => {
                    try {
                        const r = await (response as any).interrupt();
                    } catch (e) {
                        // Ignore
                    }
                    abortController.abort();
                })();
            } else {
                abortController.abort();
            }
        }
    });
    logger.debug(`[claudeRemote] Starting query with messages`);
    response = query({
        prompt: opts.messages,
        abortController: abortController,
        options: sdkOptions,
    });

    printDivider();
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        // NOTE: Undocumented in the sdk.d.ts, but it exists
        // Hoping to use this to abort the response before we will timeout
        // our our permission request
        // Lets test behavior first
        // setTimeout(() => {
        //     console.log('Interrupting claude remote execution');
        //     // @ts-ignore
        //     response.interrupt()

        //     // Next after 
        // }, 1000 * 30)

        for await (const message of response) {
            logger.debug(`[claudeRemote] Received message from SDK: ${message.type}`);
            // Always format and display the message
            formatClaudeMessage(message, opts.onAssistantResult);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {

                // Session id is still in memory, wait until session file is  written to disk
                // Start a watcher for to detect the session id
                const projectName = resolve(opts.path).replace(/\//g, '-')
                const projectDir = join(homedir(), '.claude', 'projects', projectName);
                mkdirSync(projectDir, { recursive: true });
                const watcher = watch(projectDir)
                    .on('change', (_, filename) => {
                        if (filename === `${message.session_id}.jsonl`) {
                            opts.onSessionFound(message.session_id);
                            watcher.close();
                        }
                    });
            }
        }
        logger.debug(`[claudeRemote] Finished iterating over response`);
    } catch (e) {
        if (abortController.signal.aborted) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        }
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    }
    printDivider();
    logger.debug(`[claudeRemote] Function completed`);
}
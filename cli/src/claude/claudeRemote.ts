import { query, type Options, type SDKUserMessage, type SDKMessage, AbortError } from '@anthropic-ai/claude-code'
import { formatClaudeMessage, printDivider, type OnAssistantResultCallback } from '@/ui/messageFormatter'
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';
import { mkdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type { InterruptController } from './InterruptController';

export async function claudeRemote(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    onSessionFound: (id: string) => void,
    messages: AsyncIterable<SDKUserMessage>,
    onAssistantResult?: OnAssistantResultCallback,
    interruptController?: InterruptController
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

    /*
    UPDATE: Not working, will timeout and interrupt for now after 4.5 minutes.
    
    NOTE: @kirill We do not have a direct way to pass in env to the sdk without patching it, but it uses ...process.env to pass .env to spawn.

    See more about permission handling in this file TODO link

    Setting infinite timeout for MCP_TOOL_TIMEOUT & MCP_TIMEOUT

    Setting MCP_TOOL_TIMEOUT to 100 -> times it out very fast

    This though does not solve the timout issue
    process.env.MCP_TOOL_TIMEOUT = '100000000'; // 27.8 hours
    process.env.MCP_TIMEOUT = '100000000'; // 27.8 hours
    */
    response = query({
        prompt: opts.messages,
        abortController: abortController,
        options: sdkOptions,
    });

    // Register interrupt function if controller provided
    if (opts.interruptController) {
        opts.interruptController.register(async () => {
            logger.debug('[claudeRemote] Interrupting Claude via SDK');
            // @ts-ignore - undocumented but exists
            await response.interrupt();
        });
    }

    printDivider();
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

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
    } finally {
        // Clean up interrupt registration
        if (opts.interruptController) {
            opts.interruptController.unregister();
        }
    }
    printDivider();
    logger.debug(`[claudeRemote] Function completed`);
}
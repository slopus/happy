import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from './utils/claudeCheckSession';
import { logger } from '@/ui/logger';
import { join } from 'node:path';
import { awaitFileExist } from '@/modules/watcher/awaitFileExist';
import { getProjectPath } from './utils/path';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';

export async function claudeRemote(opts: {
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    message: string,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    signal?: AbortSignal,
    onMessage: (message: SDKMessage) => void
}) {
    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Bridge external abort signal to SDK's abort controller
    let response: AsyncIterableIterator<SDKMessage> & { interrupt?: () => Promise<void> };

    // Prepare SDK options
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
        permissionMode: opts.permissionMode,
        executable: 'node',
        abort: opts.signal,
    }

    // Add Claude CLI arguments to executableArgs
    if (opts.claudeArgs && opts.claudeArgs.length > 0) {
        sdkOptions.executableArgs = [...(sdkOptions.executableArgs || []), ...opts.claudeArgs];
    }

    logger.debug(`[claudeRemote] Starting query with permission mode: ${opts.permissionMode}`);

    let message = new PushableAsyncIterable<SDKUserMessage>();
    message.push({
        type: 'user',
        message: {
            role: 'user',
            content: opts.message,
        },
    });
    message.end();

    response = query({
        prompt: message,
        options: sdkOptions,
    });

    // // Send interrupt immediately if abort signal is received
    // if (opts.signal) {
    //     if (opts.signal.aborted) {
    //         logger.debug(`[claudeRemote] Abort signal received, exiting claudeRemote`);
    //         await response.interrupt?.();
    //     } else {
    //         opts.signal.addEventListener('abort', async () => {
    //             logger.debug(`[claudeRemote] Abort signal received, exiting claudeRemote`);
    //             await response.interrupt?.();
    //         });
    //     }
    // }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                // Session id is still in memory, wait until session file is  written to disk
                // Start a watcher for to detect the session id
                const systemInit = message as SDKSystemMessage;
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Stop thinking when result is received and exit
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');
                break; // Exit the loop when result is received
            }
        }
        logger.debug(`[claudeRemote] Finished iterating over response`);
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        // Stop thinking when exiting
        updateThinking(false);
    }

    logger.debug(`[claudeRemote] Function completed`);
}
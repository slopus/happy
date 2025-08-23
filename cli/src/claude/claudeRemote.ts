import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from './utils/claudeCheckSession';
import { logger } from '@/ui/logger';
import { join, resolve, dirname } from 'node:path';
import { awaitFileExist } from '@/modules/watcher/awaitFileExist';
import { getProjectPath } from './utils/path';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { projectPath } from '@/projectPath';
import { parseSpecialCommand } from '@/parsers/specialCommands';

export async function claudeRemote(opts: {
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    responses: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>,
    message: string,
    model?: string,
    fallbackModel?: string,
    customSystemPrompt?: string,
    appendSystemPrompt?: string,
    allowedTools?: string[],
    disallowedTools?: string[],
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    signal?: AbortSignal,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
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

    // let exitReason: 'tool_rejected' | null = null;

    // Bridge external abort signal to SDK's abort controller
    let response: AsyncIterableIterator<SDKMessage> & { interrupt?: () => Promise<void> };

    // Prepare SDK options
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
        permissionMode: opts.permissionMode,
        model: opts.model,
        fallbackModel: opts.fallbackModel,
        customSystemPrompt: opts.customSystemPrompt,
        appendSystemPrompt: opts.appendSystemPrompt,
        allowedTools: opts.allowedTools,
        disallowedTools: opts.disallowedTools,
        executable: 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
    }

    // Add Claude CLI arguments to executableArgs
    if (opts.claudeArgs && opts.claudeArgs.length > 0) {
        sdkOptions.executableArgs = [...(sdkOptions.executableArgs || []), ...opts.claudeArgs];
    }

    logger.debug(`[claudeRemote] Starting query with permission mode: ${opts.permissionMode}, model: ${opts.model || 'default'}, fallbackModel: ${opts.fallbackModel || 'none'}, customSystemPrompt: ${opts.customSystemPrompt ? 'set' : 'none'}, appendSystemPrompt: ${opts.appendSystemPrompt ? 'set' : 'none'}, allowedTools: ${opts.allowedTools ? opts.allowedTools.join(',') : 'none'}, disallowedTools: ${opts.disallowedTools ? opts.disallowedTools.join(',') : 'none'}`);

    // Parse special commands and handle them
    const specialCommand = parseSpecialCommand(opts.message);

    if (specialCommand.type === 'clear') {
        logger.debug('[claudeRemote] /clear command detected - should not reach here, handled in start.ts');
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
    }

    // Track if this is a compact command for completion message
    const isCompactCommand = specialCommand.type === 'compact';

    // Send compaction started message immediately for compact commands
    if (isCompactCommand) {
        logger.debug('[claudeRemote] Compaction started');
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

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

    // Start thinking early
    updateThinking(true);

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

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
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

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                }

                return; // Exit the loop when result is received
            }

            // Handle plan result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) { // Exit on any result of plan mode tool call
                            logger.debug('[claudeRemote] Plan result received, exiting claudeRemote');
                            return;
                        }
                        if (c.type === 'tool_result' && c.tool_use_id && opts.responses.has(c.tool_use_id) && !opts.responses.get(c.tool_use_id)!!.approved) { // Exit on any tool permission rejection
                            logger.debug('[claudeRemote] Tool rejected, exiting claudeRemote');
                            return;
                        }
                    }
                }
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
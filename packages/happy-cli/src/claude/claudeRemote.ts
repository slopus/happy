import { EnhancedMode } from "./loop";
import { Query, query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { formatMessageForClaude, ClaudeContent } from '@/utils/formatImageMessage';
import { ImageContent } from '@/api/types';

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string | { type: 'text'; text: string } | { type: 'mixed'; text: string; images: ImageContent[] }, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    /** Called when the SDK Query instance is created, allowing the caller to call interrupt() */
    onQueryCreated?: (query: Query) => void,
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume and --fork-session from claudeArgs if present (for first spawn)
    let forkSession = false;
    if (opts.claudeArgs) {
        // Check for --fork-session flag
        if (opts.claudeArgs.includes('--fork-session')) {
            forkSession = true;
            logger.debug('[claudeRemote] Found --fork-session flag');
        }

        // Extract --resume if not already set
        if (!startFrom) {
            for (let i = 0; i < opts.claudeArgs.length; i++) {
                if (opts.claudeArgs[i] === '--resume') {
                    // Check if next arg exists and looks like a session ID
                    if (i + 1 < opts.claudeArgs.length) {
                        const nextArg = opts.claudeArgs[i + 1];
                        // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                        if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                            startFrom = nextArg;
                            logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                            break;
                        } else {
                            // Just --resume without UUID - SDK doesn't support this
                            logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                            break;
                        }
                    } else {
                        // --resume at end of args - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Extract text from message for special command parsing
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : initial.message.text;

    // Handle special commands
    const specialCommand = parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        // Immediately signal thinking=false so the server clears awaitingTurnStart
        // without waiting for the next 2s heartbeat interval. This prevents
        // subsequent messages from being unnecessarily queued as pending.
        if (opts.onThinkingChange) {
            opts.onThinkingChange(false);
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        forkSession: forkSession || undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        effort: initial.mode.reasoningEffort,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: opts.jsRuntime ?? 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        settingsPath: opts.hookSettingsPath,
    }

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

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();

    // Normalize queue message payloads into Claude SDK content format
    const toClaudeMessageContent = async (
        message: string | { type: 'text'; text: string } | { type: 'mixed'; text: string; images: ImageContent[] }
    ): Promise<string | ClaudeContent[]> => {
        if (typeof message === 'object' && 'type' in message) {
            if (message.type === 'mixed') {
                return formatMessageForClaude(message.text, message.images);
            }
            return message.text;
        }
        return message;
    };

    const initialMessageContent = await toClaudeMessageContent(initial.message);

    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initialMessageContent,
        },
    });

    let awaitingNextUserMessage = false;
    let streamEnded = false;
    const pumpNextUserMessage = async (): Promise<void> => {
        if (awaitingNextUserMessage || streamEnded) {
            return;
        }
        awaitingNextUserMessage = true;
        try {
            const next = await opts.nextMessage();
            if (!next) {
                streamEnded = true;
                messages.end();
                return;
            }
            mode = next.mode;
            const messageContent = await toClaudeMessageContent(next.message);
            messages.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: messageContent
                }
            });
        } catch (error) {
            logger.debug('[claudeRemote] Failed to fetch next user message', error);
            streamEnded = true;
            messages.end();
        } finally {
            awaitingNextUserMessage = false;
        }
    };

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    // Expose Query instance so the caller can call interrupt() for graceful abort
    opts.onQueryCreated?.(response);

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

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, waiting for next user message');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                // Keep consuming SDK output while waiting for next user message.
                // Waiting inline here can block late-arriving events (task notifications, tool outputs)
                // until the user sends another message.
                void pumpNextUserMessage();
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
    }
}

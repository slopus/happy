import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/backends/claude/sdk'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/cli/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    transcriptPath: string | null,
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
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void,
}) {

    // Determine how we should (re)start the Claude session.
    //
    // IMPORTANT: do not "fail closed" to a fresh session just because our local transcript check
    // can't validate the session yet. That can cause context loss during fast local↔remote switching
    // (the session file may exist but not contain "uuid/messageId" lines yet).
    let startFrom = opts.sessionId;
    let shouldContinue = false;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path, opts.transcriptPath)) {
        logger.debug(`[claudeRemote] Session ${opts.sessionId} did not pass transcript validation yet; attempting resume anyway`);
    }
    
    // If we don't have an explicit sessionId to resume from, honor one-time session flags.
    // (These are consumed by Session.consumeOneTimeFlags() after the first successful spawn.)
    if (!startFrom && opts.claudeArgs) {
        // --continue / -c: let Claude pick the last session, but still run in SDK mode
        if (opts.claudeArgs.includes('--continue') || opts.claudeArgs.includes('-c')) {
            shouldContinue = true;
        }

        // --resume / -r: in remote mode we can't show the interactive picker, so:
        // - `--resume <id>` / `-r <id>` resumes that id
        // - `--resume` / `-r` resumes the most recent valid UUID session in this project
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            const arg = opts.claudeArgs[i];
            if (arg !== '--resume' && arg !== '-r') continue;

            const maybeValue = i + 1 < opts.claudeArgs.length ? opts.claudeArgs[i + 1] : undefined;
            if (maybeValue && !maybeValue.startsWith('-')) {
                startFrom = maybeValue;
                logger.debug(`[claudeRemote] Found ${arg} with session ID: ${startFrom}`);
            } else {
                const lastSession = claudeFindLastSession(opts.path, opts.claudeEnvVars?.CLAUDE_CONFIG_DIR ?? null);
                if (lastSession) {
                    startFrom = lastSession;
                    logger.debug(`[claudeRemote] Found ${arg} without id; using last session: ${startFrom}`);
                } else {
                    logger.debug(`[claudeRemote] Found ${arg} without id but no valid last session was found`);
                }
            }

            // Explicit resume overrides --continue semantics.
            shouldContinue = false;
            break;
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

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
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
        continue: shouldContinue || undefined,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
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
    opts.setUserMessageSender?.((message: SDKUserMessage) => messages.push(message));
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

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
                if (systemInit.session_id) {
                    // Do not block on filesystem writes here.
                    // The session scanner can handle missing files via watcher retries + UI warnings.
                    logger.debug(`[claudeRemote] Session initialized: ${systemInit.session_id}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

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

                // Push next message
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
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
        opts.setUserMessageSender?.(null);
        updateThinking(false);
    }
}

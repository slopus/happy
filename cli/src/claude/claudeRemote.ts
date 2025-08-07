import { query, type QueryOptions as Options, type SDKUserMessage, type SDKMessage, type SDKAssistantMessage, type SDKSystemMessage, AbortError } from '@/claude/sdk'
import { formatClaudeMessage, printDivider, type OnAssistantResultCallback } from '@/ui/messageFormatter'
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';
import { join } from 'node:path';
import type { InterruptController } from './InterruptController';
import { awaitFileExist } from '@/modules/watcher/awaitFileExist';
import { getProjectPath } from './path';

// Deep equality helper for comparing tool arguments
function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!deepEqual(a[key], b[key])) return false;
    }
    
    return true;
}

export async function claudeRemote(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    message: string,
    onAssistantResult?: OnAssistantResultCallback,
    interruptController?: InterruptController,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    onToolCallResolver?: (resolver: ((name: string, args: any) => string | null) | null) => void
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

    // Prepare SDK options
    const abortController = new AbortController();
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
        permissionMode: opts.permissionMode,
        executable: 'node',
        abortController: abortController,
    }

    // Add Claude CLI arguments to executableArgs
    if (opts.claudeArgs && opts.claudeArgs.length > 0) {
        sdkOptions.executableArgs = [...(sdkOptions.executableArgs || []), ...opts.claudeArgs];
    }

    // Query Claude
    let aborted = false;
    let response: AsyncIterableIterator<SDKMessage> & { interrupt?: () => Promise<void> };
    opts.abort.addEventListener('abort', () => {
        if (!aborted) {
            aborted = true;
            if (response) {
                (async () => {
                    try {
                        await (response as any).interrupt();
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
    logger.debug(`[claudeRemote] Starting query with permission mode: ${opts.permissionMode}`);

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
        prompt: opts.message,
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
    
    // Track tool calls with usage flag
    const toolCalls: Array<{id: string, name: string, input: any, used: boolean}> = [];
    
    // Resolver function with usage marking
    const resolveToolCallId = (name: string, args: any): string | null => {
        // Search in reverse (most recent first)
        for (let i = toolCalls.length - 1; i >= 0; i--) {
            const call = toolCalls[i];
            if (call.name === name && deepEqual(call.input, args)) {
                if (call.used) {
                    // Found already used match - return null immediately
                    logger.debug('[claudeRemote] Warning: Permission request matched an already-used tool call');
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                logger.debug(`[claudeRemote] Resolved tool call ID: ${call.id} for ${name}`);
                return call.id;
            }
        }
        
        // No match found
        logger.debug(`[claudeRemote] No matching tool call found for permission request: ${name}`);
        return null;
    };
    
    // Provide resolver to caller
    if (opts.onToolCallResolver) {
        opts.onToolCallResolver(resolveToolCallId);
    }
    
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);
            // Always format and display the message
            formatClaudeMessage(message, opts.onAssistantResult);

            // Extract tool calls from assistant messages
            if (message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                if (assistantMsg.message && assistantMsg.message.content) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use') {
                            toolCalls.push({
                                id: block.id!,
                                name: block.name!,
                                input: block.input,
                                used: false
                            });
                            logger.debug(`[claudeRemote] Tracked tool call: ${block.id} - ${block.name}`);
                        }
                    }
                }
            }

            // Mark tool calls as used when we see their results
            if (message.type === 'user') {
                const userMsg = message as SDKUserMessage;
                
                // Check content for tool_result blocks
                if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                    for (const block of userMsg.message.content) {
                        if (block.type === 'tool_result' && block.tool_use_id) {
                            const toolCall = toolCalls.find(tc => tc.id === block.tool_use_id);
                            if (toolCall && !toolCall.used) {
                                toolCall.used = true;
                                logger.debug(`[claudeRemote] Tool completed execution, marked as used: ${block.tool_use_id}`);
                            }
                        }
                    }
                }
            }

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
        // Stop thinking when exiting
        updateThinking(false);
        
        // Clear tool calls array
        toolCalls.length = 0;
        
        // Notify caller to clear resolver reference
        if (opts.onToolCallResolver) {
            opts.onToolCallResolver(null);
        }
        
        // Clean up interrupt registration
        if (opts.interruptController) {
            opts.interruptController.unregister();
        }
    }
    printDivider();
    logger.debug(`[claudeRemote] Function completed`);
}
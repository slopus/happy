import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";


// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
    allowedTools?: string[]
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Determine session ID strategy:
    // - If resuming an existing session: use --resume (Claude keeps the same session ID)
    // - If starting fresh: generate UUID and pass via --session-id
    let startFrom = opts.sessionId;

    // Handle session-related flags from claudeArgs to ensure transparent behavior
    // We intercept these flags to use happy-cli's session storage rather than Claude's default
    //
    // Supported patterns:
    // --continue / -c           : Resume last session in current directory
    // --resume / -r             : Resume last session (picker in Claude, but we handle)
    // --resume <id> / -r <id>   : Resume specific session by ID
    // --session-id <uuid>       : Use specific UUID for new session

    // Helper to find and extract flag with optional value
    const extractFlag = (flags: string[], withValue: boolean = false): { found: boolean; value?: string } => {
        if (!opts.claudeArgs) return { found: false };

        for (const flag of flags) {
            const index = opts.claudeArgs.indexOf(flag);
            if (index !== -1) {
                if (withValue && index + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[index + 1];
                    // Check if next arg looks like a value (doesn't start with -)
                    if (!nextArg.startsWith('-')) {
                        const value = nextArg;
                        // Remove both flag and value
                        opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index && i !== index + 1);
                        return { found: true, value };
                    }
                }
                // Don't extract if value was required but not found
                if (!withValue) {
                    opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index);
                    return { found: true };
                }
                return { found: false };
            }
        }
        return { found: false };
    };

    // 1. Check for --session-id <uuid> (explicit new session with specific ID)
    const sessionIdFlag = extractFlag(['--session-id'], true);
    if (sessionIdFlag.found && sessionIdFlag.value) {
        startFrom = null; // Force new session mode, will use this ID below
        logger.debug(`[ClaudeLocal] Using explicit --session-id: ${sessionIdFlag.value}`);
    }

    // 2. Check for --resume <id> / -r <id> (resume specific session)
    if (!startFrom && !sessionIdFlag.value) {
        const resumeFlag = extractFlag(['--resume', '-r'], true);
        if (resumeFlag.found) {
            if (resumeFlag.value) {
                startFrom = resumeFlag.value;
                logger.debug(`[ClaudeLocal] Using provided session ID from --resume: ${startFrom}`);
            } else {
                // --resume without value: find last session
                const lastSession = claudeFindLastSession(opts.path);
                if (lastSession) {
                    startFrom = lastSession;
                    logger.debug(`[ClaudeLocal] --resume: Found last session: ${lastSession}`);
                }
            }
        }
    }

    // 3. Check for --continue / -c (resume last session)
    if (!startFrom && !sessionIdFlag.value) {
        const continueFlag = extractFlag(['--continue', '-c'], false);
        if (continueFlag.found) {
            const lastSession = claudeFindLastSession(opts.path);
            if (lastSession) {
                startFrom = lastSession;
                logger.debug(`[ClaudeLocal] --continue: Found last session: ${lastSession}`);
            }
        }
    }

    // Generate new session ID if not resuming
    // Priority: 1. startFrom (resuming), 2. explicit --session-id, 3. generate new UUID
    //
    // Race condition safety:
    // - New sessions: randomUUID() guarantees uniqueness even if multiple sessions start simultaneously
    // - --continue/--resume: If multiple sessions resume the same last session, that's expected
    //   behavior (Claude Code handles concurrent access to session files)
    // - --continue when no session: Falls through to randomUUID(), so each gets a unique ID
    const explicitSessionId = sessionIdFlag.value || null;
    const newSessionId = startFrom ? null : (explicitSessionId || randomUUID());
    const effectiveSessionId = startFrom || newSessionId!;

    // Notify about session ID immediately (we know it upfront now!)
    if (startFrom) {
        logger.debug(`[ClaudeLocal] Resuming session: ${startFrom}`);
        opts.onSessionFound(startFrom);
    } else if (explicitSessionId) {
        logger.debug(`[ClaudeLocal] Using explicit session ID: ${explicitSessionId}`);
        opts.onSessionFound(explicitSessionId);
    } else {
        logger.debug(`[ClaudeLocal] Generated new session ID: ${newSessionId}`);
        opts.onSessionFound(newSessionId!);
    }

    // Thinking state
    let thinking = false;
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []

            const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
            if (startFrom) {
                // Resume existing session (Claude preserves the session ID)
                args.push('--resume', startFrom)
            } else if (!hasResumeFlag) {
                // New session with our generated UUID
                args.push('--session-id', newSessionId!)
            }
            // If hasResumeFlag && !startFrom: --resume is in claudeArgs, let Claude handle it

            args.push('--append-system-prompt', systemPrompt);

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
            }

            if (opts.allowedTools && opts.allowedTools.length > 0) {
                args.push('--allowedTools', opts.allowedTools.join(','));
            }

            // Add custom Claude arguments
            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
            }

            // Prepare environment variables
            // Note: Local mode uses global Claude installation with --session-id flag
            // Launcher only intercepts fetch for thinking state tracking
            const env = {
                ...process.env,
                ...opts.claudeEnvVars
            }

            logger.debug(`[ClaudeLocal] Spawning launcher: ${claudeCliPath}`);
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

            const child = spawn('node', [claudeCliPath, ...args], {
                stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
                signal: opts.abort,
                cwd: opts.path,
                env,
            });

            // Listen to the custom fd (fd 3) for thinking state tracking
            if (child.stdio[3]) {
                const rl = createInterface({
                    input: child.stdio[3] as any,
                    crlfDelay: Infinity
                });

                // Track active fetches for thinking state
                const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

                rl.on('line', (line) => {
                    try {
                        const message = JSON.parse(line);

                        switch (message.type) {
                            case 'fetch-start':
                                activeFetches.set(message.id, {
                                    hostname: message.hostname,
                                    path: message.path,
                                    startTime: message.timestamp
                                });

                                // Clear any pending stop timeout
                                if (stopThinkingTimeout) {
                                    clearTimeout(stopThinkingTimeout);
                                    stopThinkingTimeout = null;
                                }

                                // Start thinking
                                updateThinking(true);
                                break;

                            case 'fetch-end':
                                activeFetches.delete(message.id);

                                // Stop thinking when no active fetches
                                if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                                    stopThinkingTimeout = setTimeout(() => {
                                        if (activeFetches.size === 0) {
                                            updateThinking(false);
                                        }
                                        stopThinkingTimeout = null;
                                    }, 500); // Small delay to avoid flickering
                                }
                                break;

                            default:
                                logger.debug(`[ClaudeLocal] Unknown message type: ${message.type}`);
                        }
                    } catch (e) {
                        // Not JSON, ignore (could be other output)
                        logger.debug(`[ClaudeLocal] Non-JSON line from fd3: ${line}`);
                    }
                });

                rl.on('error', (err) => {
                    console.error('Error reading from fd 3:', err);
                });

                // Cleanup on child exit
                child.on('exit', () => {
                    if (stopThinkingTimeout) {
                        clearTimeout(stopThinkingTimeout);
                    }
                    updateThinking(false);
                });
            }
            child.on('error', (error) => {
                // Ignore
            });
            child.on('exit', (code, signal) => {
                if (signal === 'SIGTERM' && opts.abort.aborted) {
                    // Normal termination due to abort signal
                    r();
                } else if (signal) {
                    reject(new Error(`Process terminated with signal: ${signal}`));
                } else {
                    r();
                }
            });
        });
    } finally {
        process.stdin.resume();
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }
        updateThinking(false);
    }

    return effectiveSessionId;
}

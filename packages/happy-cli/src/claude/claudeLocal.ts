import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { logger } from "@/ui/logger";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";

/**
 * Error thrown when the Claude process exits with a non-zero exit code.
 */
export class ExitCodeError extends Error {
    public readonly exitCode: number;

    constructor(exitCode: number) {
        super(`Process exited with code: ${exitCode}`);
        this.name = 'ExitCodeError';
        this.exitCode = exitCode;
    }
}


// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

/**
 * Unix socket server for IPC with the launcher process (thinking-state messages).
 * node-pty's spawn() only creates the PTY (fd 0/1/2) and has no stdio option
 * for extra pipes, so we use a Unix socket instead.
 */
function createIpcSocket(socketPath: string, onMessage: (msg: any) => void): Promise<Server> {
    return new Promise((resolve, reject) => {
        const server = createServer((conn) => {
            const rl = createInterface({ input: conn, crlfDelay: Infinity });
            rl.on('line', (line) => {
                try {
                    onMessage(JSON.parse(line));
                } catch {
                    logger.debug(`[ClaudeLocal] Non-JSON line on IPC socket: ${line}`);
                }
            });
            rl.on('error', (err) => {
                logger.debug(`[ClaudeLocal] IPC socket read error: ${err.message}`);
            });
        });

        server.on('error', reject);
        server.listen(socketPath, () => resolve(server));
    });
}

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools?: string[],
    /** Path to temporary settings file with SessionStart hook (optional - for session tracking) */
    hookSettingsPath?: string
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if claudeArgs contains --continue or --resume (user passed these flags)
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = hasContinueFlag || hasResumeFlag;

    // Determine if we have an existing session to resume
    // Session ID will always be provided by hook (SessionStart) when Claude starts
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
    // Session ID handling depends on whether we have a hook server
    // - With hookSettingsPath: Session ID comes from Claude via hook (normal mode)
    // - Without hookSettingsPath: We generate session ID ourselves (offline mode)
    const explicitSessionId = sessionIdFlag.value || null;
    let newSessionId: string | null = null;
    let effectiveSessionId: string | null = startFrom;

    if (!opts.hookSettingsPath) {
        // Offline mode: Generate session ID if not resuming
        // Priority: 1. startFrom (resuming), 2. explicit --session-id, 3. generate new UUID
        newSessionId = startFrom ? null : (explicitSessionId || randomUUID());
        effectiveSessionId = startFrom || newSessionId!;

        // Notify about session ID immediately (we know it upfront in offline mode)
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
    } else {
        // Normal mode with hook server: Session ID comes from Claude via hook
        if (startFrom) {
            logger.debug(`[ClaudeLocal] Will resume existing session: ${startFrom}`);
        } else if (hasUserSessionControl) {
            logger.debug(`[ClaudeLocal] User passed ${hasContinueFlag ? '--continue' : '--resume'} flag, session ID will be determined by hook`);
        } else {
            logger.debug(`[ClaudeLocal] Fresh start, session ID will be provided by hook`);
        }
    }

    // Thinking state
    let thinking = false;
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    const handleThinkingMessage = (message: any) => {
        switch (message.type) {
            case 'fetch-start':
                activeFetches.set(message.id, {
                    hostname: message.hostname,
                    path: message.path,
                    startTime: message.timestamp
                });
                if (stopThinkingTimeout) {
                    clearTimeout(stopThinkingTimeout);
                    stopThinkingTimeout = null;
                }
                updateThinking(true);
                break;

            case 'fetch-end':
                activeFetches.delete(message.id);
                if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                    stopThinkingTimeout = setTimeout(() => {
                        if (activeFetches.size === 0) {
                            updateThinking(false);
                        }
                        stopThinkingTimeout = null;
                    }, 500);
                }
                break;

            default:
                logger.debug(`[ClaudeLocal] Unknown thinking message type: ${message.type}`);
        }
    };

    const socketPath = join(tmpdir(), `.happy-ipc-${process.pid}-${Date.now().toString(36)}.sock`);
    let ipcServer: Server | null = null;

    try {
        ipcServer = await createIpcSocket(socketPath, handleThinkingMessage);
    } catch (err) {
        logger.debug(`[ClaudeLocal] Failed to create IPC socket: ${(err as Error).message}`);
    }

    // Spawn the process via PTY proxy
    try {
        let pty: typeof import('node-pty');
        try {
            const nodePty = await import('node-pty');
            pty = nodePty.default || nodePty;
        } catch (err) {
            throw new Error(`Failed to load node-pty native addon: ${(err as Error).message}. Try running: npm rebuild node-pty`);
        }

        await new Promise<void>((resolve, reject) => {
            const args: string[] = []

            // Session/resume args depend on whether we're in offline mode or hook mode
            if (!opts.hookSettingsPath) {
                // Offline mode: We control session ID
                const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
                if (startFrom) {
                    // Resume existing session (Claude preserves the session ID)
                    args.push('--resume', startFrom)
                } else if (!hasResumeFlag && newSessionId) {
                    // New session with our generated UUID
                    args.push('--session-id', newSessionId)
                }
            } else {
                // Normal mode with hook: Add --resume if we found a session to resume
                if (startFrom) {
                    args.push('--resume', startFrom);
                }
            }

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

            // Add hook settings for session tracking (when available)
            if (opts.hookSettingsPath) {
                args.push('--settings', opts.hookSettingsPath);
                logger.debug(`[ClaudeLocal] Using hook settings: ${opts.hookSettingsPath}`);
            }

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
            }

            // Prepare environment variables
            const env: Record<string, string> = {
                ...process.env as Record<string, string>,
                ...opts.claudeEnvVars,
            };

            if (ipcServer) {
                env.HAPPY_IPC_SOCKET = socketPath;
            }

            logger.debug(`[ClaudeLocal] Spawning via PTY: node ${claudeCliPath}`);
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(args)}`);

            // Track PTY process so the abort handler (registered before spawn) can kill it
            let ptyProcess: ReturnType<typeof pty.spawn> | null = null;

            const abortHandler = () => {
                logger.debug('[ClaudeLocal] Abort signal triggered - terminating PTY process');
                try {
                    ptyProcess?.kill();
                } catch {
                    // Already dead
                }
            };
            opts.abort.addEventListener('abort', abortHandler, { once: true });

            ptyProcess = pty.spawn('node', [claudeCliPath, ...args], {
                name: process.env.TERM || 'xterm-256color',
                cols: process.stdout.columns || 80,
                rows: process.stdout.rows || 24,
                cwd: opts.path,
                env,
            });

            logger.debug(`[ClaudeLocal] PTY child spawned with PID: ${ptyProcess.pid}`);

            // Proxy PTY output → parent stdout
            ptyProcess.onData((data: string) => {
                process.stdout.write(data);
            });

            // Proxy parent stdin → PTY
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();

            const stdinHandler = (data: Buffer) => {
                ptyProcess!.write(data.toString());
            };
            process.stdin.on('data', stdinHandler);

            // Forward terminal resize
            const resizeHandler = () => {
                try {
                    ptyProcess!.resize(
                        process.stdout.columns || 80,
                        process.stdout.rows || 24
                    );
                } catch {
                    // PTY already closed
                }
            };
            process.stdout.on('resize', resizeHandler);

            // Handle PTY exit
            ptyProcess.onExit(({ exitCode, signal }) => {
                // Clean up stdin proxy
                process.stdin.removeListener('data', stdinHandler);
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
                process.stdin.pause();

                // Clean up resize handler
                process.stdout.removeListener('resize', resizeHandler);

                // Clean up abort handler
                opts.abort.removeEventListener('abort', abortHandler);

                logger.debug(`[ClaudeLocal] PTY exited code=${exitCode} signal=${signal}`);

                if (signal && opts.abort.aborted) {
                    // Normal termination due to abort
                    resolve();
                } else if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
                    reject(new ExitCodeError(exitCode));
                } else {
                    resolve();
                }
            });
        });
    } finally {
        if (ipcServer) {
            ipcServer.close();
            try {
                unlinkSync(socketPath);
            } catch {
                // Socket file already removed
            }
        }
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }
        updateThinking(false);
    }

    // Return the effective session ID (what was actually used)
    return effectiveSessionId;
}

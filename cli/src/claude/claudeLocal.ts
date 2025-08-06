import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { watch } from "node:fs";
import { logger } from "@/ui/logger";
import { claudeCheckSession } from "./claudeCheckSession";
import { getProjectPath } from "./path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[]
}) {

    // Start a watcher for to detect the session id
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });
    const watcher = watch(projectDir);
    let resolvedSessionId: string | null = null;
    const detectedIdsRandomUUID = new Set<string>();
    const detectedIdsFileSystem = new Set<string>();
    watcher.on('change', (event, filename) => {
        if (typeof filename === 'string' && filename.toLowerCase().endsWith('.jsonl')) {
            logger.debug('change', event, filename);
            const sessionId = filename.replace('.jsonl', '');
            if (detectedIdsFileSystem.has(sessionId)) {
                return;
            }
            detectedIdsFileSystem.add(sessionId);

            // Try to match
            if (resolvedSessionId) {
                return;
            }

            // Try to match with random UUID
            if (detectedIdsRandomUUID.has(sessionId)) {
                resolvedSessionId = sessionId;
                opts.onSessionFound(sessionId);
            }
        }
    });

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();
        await new Promise<void>((r, reject) => {
            const args: string[] = []
            if (startFrom) {
                args.push('--resume', startFrom)
            }
            
            // Add custom Claude arguments
            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            // Check for custom Claude CLI path
            // Running with tsx path to cli is different
            const claudeCliPath = process.env.HAPPY_CLAUDE_CLI_PATH 
                || resolve(join(__dirname, '..', 'scripts', 'claudeInteractiveLaunch.cjs')) 

            // Prepare environment variables
            const env = {
                ...process.env,
                ...opts.claudeEnvVars
            }

            const child = spawn('node', [claudeCliPath, ...args], {
                stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
                signal: opts.abort,
                cwd: opts.path,
                env,
            });

            // Listen to the custom fd (fd 3) line by line
            if (child.stdio[3]) {
                const rl = createInterface({
                    input: child.stdio[3] as any,
                    crlfDelay: Infinity
                });

                // Track active fetches for thinking state
                const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();
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

                rl.on('line', (line) => {
                    try {
                        // Try to parse as JSON
                        const message = JSON.parse(line);
                        
                        switch (message.type) {
                            case 'uuid':
                                detectedIdsRandomUUID.add(message.value);
                                
                                if (!resolvedSessionId && detectedIdsFileSystem.has(message.value)) {
                                    resolvedSessionId = message.value;
                                    opts.onSessionFound(message.value);
                                }
                                break;
                                
                            case 'fetch-start':
                                logger.debug(`[ClaudeLocal] Fetch start: ${message.method} ${message.hostname}${message.path} (id: ${message.id})`);
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
                                logger.debug(`[ClaudeLocal] Fetch end: id ${message.id}`);
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
        watcher.close();
        process.stdin.resume();
    }

    //
    // Double check that session is correct
    //

    return resolvedSessionId;
}
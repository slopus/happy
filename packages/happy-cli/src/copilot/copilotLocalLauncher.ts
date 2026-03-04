/**
 * Copilot Local Launcher
 * 
 * Spawns the native `copilot` CLI as a child process for direct terminal
 * interaction. A session scanner watches Copilot's events.jsonl on disk
 * and relays events to the Happy app in real-time.
 * 
 * Modeled on claude/claudeLocalLauncher.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';
import { CopilotSession } from './copilotSession';
import { createCopilotSessionScanner } from './utils/copilotSessionScanner';
import { Future } from '@/utils/future';

export type LauncherResult = { type: 'switch' } | { type: 'exit'; code: number };

const COPILOT_SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

/**
 * Launch native Copilot CLI in the terminal with session scanning.
 * Returns 'switch' when user triggers remote mode, 'exit' on normal exit.
 */
export async function copilotLocalLauncher(session: CopilotSession): Promise<LauncherResult> {
    let exitReason: LauncherResult | null = null;
    let copilotProcess: ChildProcess | null = null;
    const exitFuture = new Future<void>();

    // Create session scanner to relay events to Happy app
    const scanner = await createCopilotSessionScanner({
        onEnvelope: (envelope) => {
            session.client.sendSessionProtocolMessage(envelope);
        },
        onSessionIdDetected: (sessionId) => {
            if (!session.copilotSessionId || session.copilotSessionId !== sessionId) {
                session.onCopilotSessionFound(sessionId);
            }
        },
    });

    try {
        // Build copilot CLI args
        const args: string[] = [];
        if (session.copilotSessionId) {
            args.push('--resume', session.copilotSessionId);
        }

        async function killProcess() {
            if (copilotProcess && !copilotProcess.killed) {
                copilotProcess.kill('SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 500));
                if (copilotProcess && !copilotProcess.killed) {
                    copilotProcess.kill('SIGKILL');
                }
            }
        }

        async function doSwitch() {
            logger.debug('[copilotLocal] Switching to remote mode');
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            await killProcess();
        }

        async function doAbort() {
            logger.debug('[copilotLocal] Abort requested');
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            session.queue.reset();
            await killProcess();
        }

        // Register RPC handlers for mode switching
        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

        // Switch to remote when message received from app
        session.queue.setOnMessage(() => {
            doSwitch();
        });

        // If messages already queued, switch immediately
        if (session.queue.size() > 0) {
            return { type: 'switch' };
        }

        // Snapshot existing sessions before spawn (to detect new one)
        const existingSessionIds = new Set<string>();
        try {
            for (const entry of readdirSync(COPILOT_SESSION_STATE_DIR)) {
                existingSessionIds.add(entry);
            }
        } catch { /* directory may not exist yet */ }

        // Spawn copilot
        logger.debug(`[copilotLocal] Spawning: copilot ${args.join(' ')}`);
        copilotProcess = spawn('copilot', args, {
            cwd: session.path,
            stdio: 'inherit',
            env: { ...process.env },
            shell: true,
        });

        // If we already know the session ID (resuming), start watching but skip existing events
        if (session.copilotSessionId) {
            scanner.watchSession(session.copilotSessionId, true);
        } else {
            // Poll for new session directory (Copilot creates it on startup)
            const pollForNewSession = setInterval(() => {
                try {
                    for (const entry of readdirSync(COPILOT_SESSION_STATE_DIR)) {
                        if (!existingSessionIds.has(entry) && /^[0-9a-f]{8}-/.test(entry)) {
                            const stat = statSync(join(COPILOT_SESSION_STATE_DIR, entry));
                            if (stat.isDirectory()) {
                                logger.debug(`[copilotLocal] Detected new session: ${entry}`);
                                session.onCopilotSessionFound(entry);
                                // New session — relay all events including user input
                                scanner.watchSession(entry, false);
                                clearInterval(pollForNewSession);
                                return;
                            }
                        }
                    }
                } catch { /* ignore */ }
            }, 500);

            // Clean up polling on exit
            copilotProcess.on('exit', () => clearInterval(pollForNewSession));
        }

        copilotProcess.on('exit', (code, signal) => {
            logger.debug(`[copilotLocal] Process exited: code=${code}, signal=${signal}`);
            copilotProcess = null;
            if (!exitReason) {
                exitReason = { type: 'exit', code: code ?? 0 };
            }
            exitFuture.resolve(undefined);
        });

        copilotProcess.on('error', (err) => {
            logger.debug('[copilotLocal] Process error:', err);
            if (!exitReason) {
                exitReason = { type: 'exit', code: 1 };
            }
            exitFuture.resolve(undefined);
        });

        // Wait for process to exit or mode switch
        await exitFuture.promise;

    } finally {
        // Cleanup
        await scanner.cleanup();
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.queue.setOnMessage(null);
    }

    return exitReason || { type: 'exit', code: 0 };
}

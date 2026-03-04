/**
 * Copilot Local Launcher
 * 
 * Spawns the native `copilot` CLI as a child process for direct terminal
 * interaction. A session scanner watches Copilot's events.jsonl on disk
 * and relays events to the Happy app in real-time.
 * 
 * The session ID is either resumed from a previous mode switch, or
 * pre-generated and passed via `--resume <uuid>` to control which
 * session Copilot uses (avoiding filesystem polling).
 * 
 * Modeled on claude/claudeLocalLauncher.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

    // Determine session ID: reuse existing or generate a new one
    const copilotSessionId = session.copilotSessionId ?? randomUUID();
    if (!session.copilotSessionId) {
        session.onCopilotSessionFound(copilotSessionId);
    }

    // Create session scanner to relay events to Happy app
    const scanner = await createCopilotSessionScanner({
        onEnvelope: (envelope) => {
            logger.debug(`[copilotLocal] Sending envelope: role=${envelope.role}, ev.t=${envelope.ev.t}${envelope.ev.t === 'text' ? `, text=${(envelope.ev as any).text?.substring(0, 50)}` : ''}`);
            session.client.sendSessionProtocolMessage(envelope);
        },
        onSessionIdDetected: (sessionId) => {
            if (session.copilotSessionId !== sessionId) {
                session.onCopilotSessionFound(sessionId);
            }
        },
    });

    try {
        // Build copilot CLI args — always pass --resume with our known session ID
        const args: string[] = ['--resume', copilotSessionId];

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

        // Start watching the known session immediately — no polling needed
        const isResume = session.copilotSessionId === copilotSessionId && copilotSessionId !== null;
        logger.debug(`[copilotLocal] Watching session: ${copilotSessionId}, isResume: ${isResume}`);
        // For resumed sessions skip existing events; for new sessions relay everything
        scanner.watchSession(copilotSessionId, isResume);

        // Spawn copilot with our session ID
        logger.debug(`[copilotLocal] Spawning: copilot ${args.join(' ')}`);
        copilotProcess = spawn('copilot', args, {
            cwd: session.path,
            stdio: 'inherit',
            env: { ...process.env },
            shell: true,
        });

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

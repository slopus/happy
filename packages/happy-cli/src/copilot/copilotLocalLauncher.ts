/**
 * Copilot Local Launcher
 * 
 * Spawns the native `copilot` CLI as a child process for direct terminal
 * interaction. Output is relayed to the Happy session for mobile viewing.
 * 
 * Modeled on claude/claudeLocalLauncher.ts.
 * PTY relay patterns adapted from ~/agency-wrapper.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '@/ui/logger';
import { CopilotSession } from './copilotSession';
import { Future } from '@/utils/future';

export type LauncherResult = { type: 'switch' } | { type: 'exit'; code: number };

/**
 * Launch native Copilot CLI in the terminal.
 * Returns 'switch' when user triggers remote mode, 'exit' on normal exit.
 */
export async function copilotLocalLauncher(session: CopilotSession): Promise<LauncherResult> {
    let exitReason: LauncherResult | null = null;
    let copilotProcess: ChildProcess | null = null;
    const exitFuture = new Future<void>();

    try {
        // Build copilot CLI args
        const args: string[] = [];
        if (session.copilotSessionId) {
            args.push('--resume', session.copilotSessionId);
        }

        async function killProcess() {
            if (copilotProcess && !copilotProcess.killed) {
                copilotProcess.kill('SIGTERM');
                // Give it a moment to exit gracefully
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

        // Spawn copilot
        logger.debug(`[copilotLocal] Spawning: copilot ${args.join(' ')}`);
        copilotProcess = spawn('copilot', args, {
            cwd: session.path,
            stdio: 'inherit', // Direct terminal interaction
            env: { ...process.env },
            shell: true,
        });

        // Relay session ID from the ACP newSession response if we don't have one yet
        // (The session ID will be detected when we enter remote mode for the first time)

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
        // Cleanup handlers
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.queue.setOnMessage(null);
    }

    return exitReason || { type: 'exit', code: 0 };
}

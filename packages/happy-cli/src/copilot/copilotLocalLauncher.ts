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

import { spawn, exec, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { CopilotSession } from './copilotSession';
import type { CopilotSessionScanner } from './utils/copilotSessionScanner';
import { Future } from '@/utils/future';

export type LauncherResult = { type: 'switch' } | { type: 'exit'; code: number };

/**
 * Launch native Copilot CLI in the terminal with session scanning.
 * Returns 'switch' when user triggers remote mode, 'exit' on normal exit.
 * 
 * The scanner is passed in from copilotLoop so processedIds persists across
 * mode switches, preventing remote-session events from being replayed.
 */
export async function copilotLocalLauncher(session: CopilotSession, scanner: CopilotSessionScanner): Promise<LauncherResult> {
    let exitReason: LauncherResult | null = null;
    let copilotProcess: ChildProcess | null = null;
    const exitFuture = new Future<void>();

    // Determine session ID: reuse existing or generate a new one
    const copilotSessionId = session.copilotSessionId ?? randomUUID();
    logger.debug(`[copilotLocal] Starting launcher. session.copilotSessionId=${session.copilotSessionId}, using=${copilotSessionId}`);
    if (!session.copilotSessionId) {
        session.onCopilotSessionFound(copilotSessionId);
    }

    try {
        // Build copilot CLI args — always pass --resume with our known session ID
        const args: string[] = ['--resume', copilotSessionId];
        logger.debug(`[copilotLocal] Args: ${JSON.stringify(args)}, cwd=${session.path}`);

        async function killProcess() {
            if (!copilotProcess || copilotProcess.killed || !copilotProcess.pid) return;
            const pid = copilotProcess.pid;

            if (process.platform === 'win32') {
                // shell:true spawns cmd.exe which creates the copilot process as a child.
                // A plain kill() only terminates cmd.exe — the copilot process survives
                // as an orphan and keeps holding the terminal.
                // taskkill /T kills the entire process tree rooted at cmd.exe.
                try {
                    execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
                } catch {
                    copilotProcess.kill('SIGTERM');
                }
            } else {
                copilotProcess.kill('SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 500));
                if (copilotProcess && !copilotProcess.killed) {
                    copilotProcess.kill('SIGKILL');
                }
            }
        }

        async function doSwitch() {
            logger.debug('[copilotLocal] doSwitch called, exitReason was:', exitReason);
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            await killProcess();
        }

        async function doAbort() {
            logger.debug('[copilotLocal] doAbort called, exitReason was:', exitReason);
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            session.queue.reset();
            await killProcess();
        }

        // Register RPC handlers for mode switching
        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

        // Reset queue to clear any stale messages that accumulated during mode transitions
        logger.debug(`[copilotLocal] Queue size before reset: ${session.queue.size()}`);
        session.queue.reset();

        // Switch to remote when message received from app
        session.queue.setOnMessage(() => {
            logger.debug('[copilotLocal] onMessage triggered — switching to remote');
            doSwitch();
        });

        // If messages already queued, switch immediately
        if (session.queue.size() > 0) {
            logger.debug(`[copilotLocal] Queue already has ${session.queue.size()} messages — switching immediately`);
            return { type: 'switch' };
        }

        // Start watching the known session immediately — no polling needed
        const isResume = session.copilotSessionId === copilotSessionId && copilotSessionId !== null;
        logger.debug(`[copilotLocal] Watching session: ${copilotSessionId}, isResume: ${isResume}`);
        // For resumed sessions skip existing events; for new sessions relay everything
        scanner.watchSession(copilotSessionId, isResume);

        // Pause stdin so Node.js doesn't consume bytes meant for the child's TUI.
        // The remote launcher's cleanup now pauses stdin after Ink unmounts, but
        // we pause here too as a safety net for the initial launch.
        logger.debug(`[copilotLocal] stdin: readable=${process.stdin.readable}, isPaused=${process.stdin.isPaused()}, isTTY=${process.stdin.isTTY}, isRaw=${(process.stdin as any).isRaw}, listenerCount(data)=${process.stdin.listenerCount('data')}`);
        console.clear();
        process.stdin.pause();
        logger.debug(`[copilotLocal] Spawning: copilot ${args.join(' ')}, cwd=${session.path}`);
        copilotProcess = spawn('copilot', args, {
            cwd: session.path,
            stdio: 'inherit',
            env: { ...process.env },
            shell: true,
        });

        // Copilot's --resume mode may wait for input before rendering its TUI.
        // Inject a synthetic Enter via PowerShell SendKeys to trigger the render.
        if (process.platform === 'win32' && session.copilotSessionId) {
            setTimeout(() => {
                if (copilotProcess && !copilotProcess.killed) {
                    try {
                        exec(
                            'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"',
                            { timeout: 3000 },
                        );
                    } catch {}
                }
            }, 500);
        }

        copilotProcess.on('exit', (code, signal) => {
            logger.debug(`[copilotLocal] Process exited: code=${code}, signal=${signal}, exitReason=${JSON.stringify(exitReason)}`);
            copilotProcess = null;
            if (!exitReason) {
                exitReason = { type: 'exit', code: code ?? 0 };
            }
            exitFuture.resolve(undefined);
        });

        copilotProcess.on('error', (err) => {
            logger.debug('[copilotLocal] Process error:', err.message, err.stack);
            if (!exitReason) {
                exitReason = { type: 'exit', code: 1 };
            }
            exitFuture.resolve(undefined);
        });

        logger.debug('[copilotLocal] Waiting for process exit...');
        // Wait for process to exit or mode switch
        await exitFuture.promise;
        logger.debug(`[copilotLocal] exitFuture resolved. exitReason=${JSON.stringify(exitReason)}`);

    } finally {
        process.stdin.resume();
        // Do NOT call scanner.cleanup() here — the scanner is owned by copilotLoop
        // and must persist across mode switches to keep processedIds intact.
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.queue.setOnMessage(null);
    }

    return exitReason || { type: 'exit', code: 0 };
}

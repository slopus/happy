/**
 * Runs the Kimi Code CLI's own TUI in the foreground.
 *
 * Unlike the ACP backends — which speak JSON-RPC over stdio and therefore have
 * no interface of their own — local mode hands the terminal straight to `kimi`
 * so the user gets the native UI. Happy stays out of the way here and mirrors
 * the conversation to the phone by tailing the session transcript instead of
 * intercepting the stream (see kimiSessionScanner.ts).
 *
 * stdio is inherited rather than run through a PTY: nothing needs to be parsed
 * out of the terminal stream, so a PTY would only add a copy layer and risk
 * mangling the TUI's rendering.
 */

import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';

export class KimiExitCodeError extends Error {
    readonly exitCode: number;

    constructor(exitCode: number) {
        super(`kimi exited with code: ${exitCode}`);
        this.name = 'KimiExitCodeError';
        this.exitCode = exitCode;
    }
}

/**
 * Spawn the Kimi TUI and resolve when it exits.
 *
 * Resolves normally on a clean exit, throws {@link KimiExitCodeError} on a
 * non-zero exit, and resolves quietly when the caller aborts (used to reclaim
 * the terminal when the phone takes over the session).
 */
export async function kimiLocal(opts: {
    abort: AbortSignal;
    path: string;
    /** Existing Kimi session to resume, e.g. when coming back from remote mode. */
    resumeSessionId: string | null;
    /** Extra flags forwarded verbatim to the kimi binary. */
    extraArgs?: string[];
}): Promise<void> {
    const args: string[] = [];
    if (opts.resumeSessionId) {
        args.push('--session', opts.resumeSessionId);
    }
    if (opts.extraArgs?.length) {
        args.push(...opts.extraArgs);
    }

    logger.debug(`[kimi-local] Spawning: kimi ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
        const child = spawn('kimi', args, {
            cwd: opts.path,
            stdio: 'inherit',
            env: process.env,
        });

        let abortedByUs = false;

        const onAbort = () => {
            abortedByUs = true;
            logger.debug('[kimi-local] Abort requested, terminating kimi');
            child.kill('SIGTERM');
        };

        if (opts.abort.aborted) {
            onAbort();
        } else {
            opts.abort.addEventListener('abort', onAbort, { once: true });
        }

        child.on('error', (error) => {
            opts.abort.removeEventListener('abort', onAbort);
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                reject(new Error("kimi executable not found. Install the Kimi Code CLI and make sure 'kimi' is on your PATH."));
                return;
            }
            reject(error);
        });

        child.on('exit', (code, signal) => {
            opts.abort.removeEventListener('abort', onAbort);
            logger.debug(`[kimi-local] kimi exited code=${code} signal=${signal} aborted=${abortedByUs}`);

            // We killed it to hand control to the phone — not a failure.
            if (abortedByUs) {
                resolve();
                return;
            }
            if (code === null || code === 0) {
                resolve();
                return;
            }
            reject(new KimiExitCodeError(code));
        });
    });
}

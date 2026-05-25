/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn as crossSpawn } from 'cross-spawn';
import { projectPath } from '@/projectPath';
import { join, resolve } from 'path';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
    /** True when stdout was capped — caller knows the result is partial. */
    truncated?: boolean
}

export interface RipgrepOptions {
    cwd?: string
    /**
     * Maximum bytes to retain from stdout. Defaults to
     * {@link DEFAULT_MAX_OUTPUT_BYTES}. The child is sent SIGTERM once the
     * cap is reached.
     */
    maxBufferBytes?: number
}

/**
 * Default cap for ripgrep stdout: 32 MiB. Empirically more than enough for
 * any sane LLM-facing grep query — and well below V8's ~512 MiB string-length
 * limit so the final `Buffer.concat(...).toString()` never throws
 * `RangeError: Invalid string length`. Reported in #1195 with crash sizes
 * up to ~1 GiB on very broad searches.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Same cap for stderr — in practice it's tiny, but we still bound it. */
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;

/**
 * Run ripgrep with the given arguments.
 *
 * stdout/stderr are accumulated as `Buffer` chunks rather than concatenated
 * strings so wide queries cannot exceed V8's max string length and crash the
 * whole CLI with `RangeError: Invalid string length` (issue #1195). Output
 * over `maxBufferBytes` is dropped, the child is killed with SIGTERM, and
 * the result is marked `truncated: true`.
 *
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout, stderr, and truncated flag
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolve(join(projectPath(), 'scripts', 'ripgrep_launcher.cjs'));
    const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolve, reject) => {
        // Use cross-spawn so `node` resolves to `node.exe` on Windows (issue #1082).
        const child = crossSpawn('node', [RUNNER_PATH, JSON.stringify(args)], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd,
            windowsHide: true,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;

        child.stdout.on('data', (data: Buffer | string) => {
            if (truncated) return;
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (stdoutBytes + buf.length > maxBufferBytes) {
                const remaining = Math.max(0, maxBufferBytes - stdoutBytes);
                if (remaining > 0) {
                    stdoutChunks.push(buf.subarray(0, remaining));
                    stdoutBytes += remaining;
                }
                truncated = true;
                // Stop the child so it doesn't keep producing output we'll
                // immediately drop. `kill` is a no-op if the process is gone.
                try { child.kill('SIGTERM'); } catch { /* already exited */ }
                return;
            }
            stdoutChunks.push(buf);
            stdoutBytes += buf.length;
        });

        child.stderr.on('data', (data: Buffer | string) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (stderrBytes + buf.length > DEFAULT_MAX_STDERR_BYTES) {
                const remaining = Math.max(0, DEFAULT_MAX_STDERR_BYTES - stderrBytes);
                if (remaining > 0) {
                    stderrChunks.push(buf.subarray(0, remaining));
                    stderrBytes += remaining;
                }
                return;
            }
            stderrChunks.push(buf);
            stderrBytes += buf.length;
        });

        child.on('close', (code) => {
            try {
                let stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
                let stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
                if (truncated) {
                    const capMb = (maxBufferBytes / (1024 * 1024)).toFixed(0);
                    const note = `\n[ripgrep: output truncated at ${capMb} MiB cap — narrow your query]\n`;
                    stderr += note;
                }
                const exitCode = code ?? (truncated ? 1 : 0);
                resolve({
                    exitCode,
                    stdout,
                    stderr,
                    truncated,
                });
            } catch (err) {
                reject(err);
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

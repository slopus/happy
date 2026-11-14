import type { ChildProcess } from 'node:child_process';
import { spawnHappyCLI } from '../utils/spawnHappyCLI';
import { logger } from '../ui/logger';

const DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

/** Skill names are optional session metadata. Filesystem hangs must not block
 * the session webhook or agent startup on the main worker's event loop. */
export function discoverCodexSkillNames(opts: {
    cwd?: string;
    homeDir?: string;
    timeoutMs?: number;
} = {}): Promise<string[]> {
    return new Promise(resolve => {
        let child: ChildProcess | undefined;
        let finished = false;
        let output = '';
        let outputBytes = 0;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (names: string[], terminate = false) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            if (child) {
                child.removeListener('close', onClose);
                child.stdout?.removeListener('data', onData);
                if (terminate) {
                    // Only this scanner handle is signalled, never a process group.
                    try { child.kill('SIGKILL'); } catch { /* best effort */ }
                }
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.unref();
            }
            resolve(names);
        };
        const unavailable = (reason: string, terminate = false) => {
            try { logger.debug(`[codex] Skill discovery unavailable (${reason}); continuing startup`); } catch { /* best effort */ }
            finish([], terminate);
        };
        const onData = (chunk: string) => {
            outputBytes += Buffer.byteLength(chunk, 'utf8');
            if (outputBytes > MAX_OUTPUT_BYTES) unavailable('output-limit', true);
            else output += chunk;
        };
        const onClose = (code: number | null) => {
            if (code !== 0) { unavailable('child-exit'); return; }
            try {
                const names: unknown = JSON.parse(output);
                if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && name.length > 0 && name.trim() === name)) {
                    unavailable('invalid-output');
                    return;
                }
                finish(names);
            } catch { unavailable('invalid-output'); }
        };
        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : DISCOVERY_TIMEOUT_MS;
        // This deadline resolves independently of close/error. A child blocked in
        // a kernel filesystem call need not acknowledge its kill before startup continues.
        deadline = setTimeout(() => unavailable('timeout', true), timeoutMs);
        try {
            child = spawnHappyCLI([JSON.stringify({ cwd: opts.cwd, homeDir: opts.homeDir })], {
                entrypoint: 'codex-skill-discovery', stdio: ['ignore', 'pipe', 'ignore'],
            });
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', onData);
            child.once('close', onClose);
            // Retain the error listener after timeout to absorb a late spawn error.
            child.on('error', () => { if (!finished) unavailable('spawn-error', true); });
        } catch { unavailable('spawn-error', true); }
    });
}

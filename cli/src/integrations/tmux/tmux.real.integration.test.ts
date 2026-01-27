/**
 * Opt-in tmux integration tests.
 *
 * These tests start isolated tmux servers (via `-S` or `TMUX_TMPDIR`) and must
 * never interact with a user's existing tmux sessions.
 *
 * Enable with: `HAPPY_CLI_TMUX_INTEGRATION=1`
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TmuxUtilities } from '@/integrations/tmux';

function isTmuxInstalled(): boolean {
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    return result.status === 0;
}

function shouldRunTmuxIntegration(): boolean {
    return process.env.HAPPY_CLI_TMUX_INTEGRATION === '1' && isTmuxInstalled();
}

function waitForFile(path: string, timeoutMs: number): Promise<void> {
    const pollIntervalMs = 50;
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`Timed out waiting for file: ${path}`));
            }
            setTimeout(tick, pollIntervalMs);
        };
        tick();
    });
}

function writeDumpScript(dir: string): string {
    const scriptPath = join(dir, 'happy-cli-tmux-dump.cjs');
    writeFileSync(
        scriptPath,
        [
            "const fs = require('fs');",
            "const outFile = process.argv[2];",
            "const keepAliveMs = Number(process.argv[3] || '0');",
            'const payload = {',
            '  argv: process.argv.slice(4),',
            '  env: {',
            '    FOO: process.env.FOO,',
            '    BAR: process.env.BAR,',
            '    TMUX: process.env.TMUX,',
            '    TMUX_PANE: process.env.TMUX_PANE,',
            '    TMUX_TMPDIR: process.env.TMUX_TMPDIR,',
            '  },',
            '};',
            'fs.writeFileSync(outFile, JSON.stringify(payload));',
            'if (keepAliveMs > 0) setTimeout(() => {}, keepAliveMs);',
            '',
        ].join('\n'),
        'utf8',
    );
    return scriptPath;
}

type DumpScriptPayload = {
    argv: string[];
    env: {
        FOO?: string;
        BAR?: string;
        TMUX?: string;
        TMUX_PANE?: string;
        TMUX_TMPDIR?: string;
    };
};

function readDumpPayload(outFile: string): DumpScriptPayload {
    return JSON.parse(readFileSync(outFile, 'utf8')) as DumpScriptPayload;
}

async function withCleanTmuxClientEnv<T>(fn: () => Promise<T>): Promise<T> {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalTmuxTmpDir = process.env.TMUX_TMPDIR;

    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.TMUX_TMPDIR;

    try {
        return await fn();
    } finally {
        if (originalTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = originalTmux;

        if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
        else process.env.TMUX_PANE = originalTmuxPane;

        if (originalTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = originalTmuxTmpDir;
    }
}

type TmuxRunResult = {
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | undefined;
};

function runTmux(args: string[], options?: { env?: Record<string, string | undefined> }): TmuxRunResult {
    // Never inherit the user's existing tmux context (TMUX/TMUX_PANE) or TMUX_TMPDIR.
    // These tests must only ever talk to isolated servers created by the test itself.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;

    const result = spawnSync('tmux', args, {
        encoding: 'utf8',
        env: {
            ...env,
            ...(options?.env ?? {}),
        } as NodeJS.ProcessEnv,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
    };
}

function killIsolatedTmuxServer(socketPath: string): void {
    const result = runTmux(['-S', socketPath, 'kill-server']);
    if (result.status !== 0 && process.env.DEBUG) {
        // Cleanup should never fail the test run, but debug logging can help diagnose flakes.
        console.error('[tmux-it] Failed to kill isolated tmux server', {
            socketPath,
            status: result.status,
            stderr: result.stderr,
            error: result.error?.message,
        });
    }
}

describe.skipIf(!shouldRunTmuxIntegration())('tmux (real) integration tests (opt-in)', { timeout: 20_000 }, () => {
    it('spawnInTmux returns a real pane PID via -P/-F (regression: PR107 option ordering)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'pid';

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'pid-check'],
                { sessionName, windowName, cwd: dir },
                {},
            );

            expect(result.success).toBe(true);
            expect(typeof result.pid).toBe('number');
            expect(result.pid).toBeGreaterThan(0);

            // Ground truth: query tmux directly for the pane pid.
            const panes = runTmux(['-S', socketPath, 'list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
            expect(panes.status).toBe(0);
            const listedPid = Number.parseInt(panes.stdout.trim(), 10);
            expect(listedPid).toBe(result.pid);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual(['pid-check']);

            // Validate the TMUX env format: socket_path,server_pid,pane (not session/window).
            expect(typeof payload.env?.TMUX).toBe('string');
            const parts = String(payload.env.TMUX).split(',');
            expect(parts.length).toBeGreaterThanOrEqual(3);
            expect(parts[0]!.length).toBeGreaterThan(0);
            expect(/^\d+$/.test(parts[1]!)).toBe(true);
        } finally {
            // Kill only the isolated server (never touch the user's default tmux server).
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux passes -e KEY=VALUE env values literally (regression: PR107 quoting/escaping)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'env';

            const env = {
                FOO: 'a$b',
                BAR: 'quote"back\\tick`',
            };

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'env-check'],
                { sessionName, windowName, cwd: dir },
                env,
            );

            expect(result.success).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);

            expect(payload.env?.FOO).toBe(env.FOO);
            expect(payload.env?.BAR).toBe(env.BAR);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux quotes command tokens safely (regression: PR107 args.join(\" \") injection/splitting)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');
            const sentinelFile = join(dir, 'injection-sentinel');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'quote';

            const argWithSpaces = 'a b';
            const argWithSingleQuote = "c'd";
            const injectionArg = `$(touch ${sentinelFile})`;

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', argWithSpaces, argWithSingleQuote, injectionArg],
                { sessionName, windowName, cwd: dir },
                {},
            );

            expect(result.success).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual([argWithSpaces, argWithSingleQuote, injectionArg]);

            // If quoting were broken, the shell would execute `touch <sentinel>` and create the file.
            expect(existsSync(sentinelFile)).toBe(false);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('TMUX_TMPDIR affects which tmux server commands talk to (regression: PR107 wrong-server assumptions)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-cli-tmux-it-'));
        // IMPORTANT: keep the socket path short to avoid unix domain socket length limits (common on macOS).
        // tmux will create tmux-<uid>/default within this directory.
        const tmuxTmpDir = mkdtempSync(join(tmpdir(), 'happy-cli-tmux-tmpdir-it-'));

        const utils = new TmuxUtilities('happy', { TMUX_TMPDIR: tmuxTmpDir });

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'tmpdir';

            const result = await withCleanTmuxClientEnv(() =>
                utils.spawnInTmux(
                    [process.execPath, scriptPath, outFile, '5000', 'tmpdir-check'],
                    { sessionName, windowName, cwd: dir },
                    {},
                ),
            );

            if (!result.success) {
                throw new Error(`spawnInTmux failed: ${result.error ?? 'unknown error'}`);
            }

            // Without TMUX_TMPDIR, a fresh tmux client should not see the isolated session.
            const defaultList = runTmux(['list-sessions']);
            expect(defaultList.stdout.includes(sessionName)).toBe(false);

            // With TMUX_TMPDIR, tmux should see our isolated session.
            const isolatedList = runTmux(['list-sessions'], { env: { TMUX_TMPDIR: tmuxTmpDir } });
            expect(isolatedList.status).toBe(0);
            expect(isolatedList.stdout.includes(sessionName)).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual(['tmpdir-check']);
        } finally {
            // Kill only the isolated server identified by TMUX_TMPDIR.
            const result = runTmux(['kill-server'], { env: { TMUX_TMPDIR: tmuxTmpDir } });
            if (result.status !== 0 && process.env.DEBUG) {
                console.error('[tmux-it] Failed to kill isolated tmux server via TMUX_TMPDIR', {
                    tmuxTmpDir,
                    status: result.status,
                    stderr: result.stderr,
                    error: result.error?.message,
                });
            }
            rmSync(tmuxTmpDir, { recursive: true, force: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

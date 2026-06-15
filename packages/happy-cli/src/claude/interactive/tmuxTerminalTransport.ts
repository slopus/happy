import {
    formatTmuxSessionIdentifier,
    parseTmuxSessionIdentifier,
    TmuxUtilities,
} from '@/utils/tmux';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    TerminalDataHandler,
    TerminalExitHandler,
    TerminalSpawnOptions,
    TerminalTransport,
} from './terminalTransport';
import {
    sanitizeTerminalEnvironment,
    sanitizeTmuxClientEnvironment,
} from './terminalEnvironment';

type TmuxPaneTarget = {
    session?: string;
    window?: string;
    pane?: string;
};

type TmuxLaunchScript = {
    dir: string;
    path: string;
};

export class TmuxTerminalTransport implements TerminalTransport {
    readonly backend = 'tmux' as const;
    readonly capabilities = ['remote-control', 'local-attach'] as const;

    terminalId: string | null = null;

    private readonly tmux: TmuxUtilities;
    private target?: TmuxPaneTarget;
    private cleanupTarget: string | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private exited = false;
    private attachProcess: ChildProcess | null = null;
    private lastCaptureText: string | null = null;
    private readonly dataHandlers = new Set<TerminalDataHandler>();
    private readonly exitHandlers = new Set<TerminalExitHandler>();

    constructor(
        private readonly sessionName: string = TmuxUtilities.DEFAULT_SESSION_NAME,
        tmux: TmuxUtilities = new TmuxUtilities(sessionName, sanitizeTmuxClientEnvironment(process.env)),
    ) {
        this.tmux = tmux;
    }

    async spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }> {
        this.stopPolling();
        this.exited = false;
        this.lastCaptureText = null;
        this.cleanupTarget = null;
        const env = sanitizeTerminalEnvironment(options.env);
        const launchScript = await createTmuxLaunchScript(options, env);

        let result;
        try {
            result = await this.tmux.spawnInTmux(
                buildTmuxLaunchScriptCommand(launchScript.path),
                {
                    cwd: options.cwd,
                    sessionName: this.sessionName,
                    windowName: options.windowName,
                },
            );
        } catch (error) {
            await cleanupTmuxLaunchScript(launchScript);
            throw error;
        }

        if (!result.success || !result.sessionId) {
            await cleanupTmuxLaunchScript(launchScript);
            throw new Error(result.error || 'Failed to spawn command in tmux');
        }

        this.terminalId = result.sessionId;
        this.target = result.paneId ? { pane: result.paneId } : parseTmuxSessionIdentifier(result.sessionId);
        this.cleanupTarget = result.windowId ?? result.sessionId;
        this.startPolling();
        return { pid: result.pid, terminalId: result.sessionId };
    }

    async attachLocal(): Promise<void> {
        if (!this.terminalId) {
            throw new Error('Tmux terminal has not been spawned');
        }

        await this.detachLocal();

        const parsedTarget = parseTmuxSessionIdentifier(this.terminalId);
        const attachTarget = formatTmuxSessionIdentifier({
            session: parsedTarget.session,
            window: parsedTarget.window,
        });

        if (parsedTarget.window) {
            const selected = await this.tmux.executeTmuxCommand(
                ['select-window'],
                parsedTarget.session,
                parsedTarget.window,
            );
            if (!selected || selected.returncode !== 0) {
                throw new Error('Failed to select tmux local attach window');
            }
        }

        if (process.env.TMUX) {
            await runTmuxClientCommand(['switch-client', '-t', attachTarget]);
            return;
        }

        const child = spawn('tmux', ['attach-session', '-t', attachTarget], {
            stdio: 'inherit',
            shell: false,
            env: sanitizeTmuxClientEnvironment(process.env),
        });
        this.attachProcess = child;

        child.once('exit', () => {
            if (this.attachProcess === child) {
                this.attachProcess = null;
            }
        });
        child.once('error', () => {
            if (this.attachProcess === child) {
                this.attachProcess = null;
            }
        });

        await waitForSpawn(child);
    }

    async detachLocal(): Promise<void> {
        const child = this.attachProcess;
        if (!child) {
            return;
        }

        this.attachProcess = null;
        if (!child.killed && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
        }
        await waitForExit(child);
    }

    async paste(text: string): Promise<void> {
        const target = this.requireTarget();
        const success = await this.tmux.pasteText(text, target.session, target.window, target.pane);
        if (!success) {
            throw new Error('Failed to paste text into tmux pane');
        }
    }

    async enter(): Promise<void> {
        const target = this.requireTarget();
        const success = await this.tmux.sendKeys('C-m', target.session, target.window, target.pane);
        if (!success) {
            throw new Error('Failed to send enter to tmux pane');
        }
    }

    async interrupt(): Promise<void> {
        const target = this.requireTarget();
        const success = await this.tmux.sendKeys('C-c', target.session, target.window, target.pane);
        if (!success) {
            throw new Error('Failed to interrupt tmux pane');
        }
    }

    async resize(cols: number, rows: number): Promise<void> {
        const target = this.requireTarget();
        const success = await this.tmux.resizePane(cols, rows, target.session, target.window, target.pane);
        if (!success) {
            throw new Error('Failed to resize tmux pane');
        }
    }

    onData(handler: TerminalDataHandler): () => void {
        this.dataHandlers.add(handler);
        return () => {
            this.dataHandlers.delete(handler);
        };
    }

    onExit(handler: TerminalExitHandler): () => void {
        this.exitHandlers.add(handler);
        return () => {
            this.exitHandlers.delete(handler);
        };
    }

    async dispose(): Promise<void> {
        await this.detachLocal();
        this.stopPolling();
        this.dataHandlers.clear();
        this.exitHandlers.clear();
        this.exited = false;

        const cleanupTarget = this.cleanupTarget ?? this.terminalId;
        this.terminalId = null;
        this.target = undefined;
        this.cleanupTarget = null;
        this.lastCaptureText = null;

        if (cleanupTarget) {
            await this.tmux.killWindow(cleanupTarget);
        }
    }

    private requireTarget(): TmuxPaneTarget {
        if (!this.target) {
            throw new Error('Tmux terminal has not been spawned');
        }
        return this.target;
    }

    private startPolling(): void {
        this.stopPolling();
        this.pollTimer = setInterval(() => {
            void this.pollCapture();
        }, 500);
        void this.pollCapture();
    }

    private stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.polling = false;
    }

    private async pollCapture(): Promise<void> {
        if (this.polling || !this.target) {
            return;
        }

        this.polling = true;
        try {
            const target = this.target;
            const isAlive = await this.tmux.isPaneAlive(target.session, target.window, target.pane);
            if (!isAlive) {
                this.handleExit();
                return;
            }

            const text = await this.tmux.capturePaneText(target.session, target.window, target.pane);
            if (this.lastCaptureText === null) {
                this.lastCaptureText = text;
                if (text) {
                    this.emitData(text);
                }
                return;
            }

            if (text !== this.lastCaptureText) {
                this.lastCaptureText = text;
                this.emitData(text);
            }
        } finally {
            this.polling = false;
        }
    }

    private emitData(data: string): void {
        for (const handler of this.dataHandlers) {
            handler(data);
        }
    }

    private handleExit(): void {
        if (this.exited) {
            return;
        }

        this.exited = true;
        this.stopPolling();
        this.terminalId = null;
        this.target = undefined;
        this.cleanupTarget = null;
        this.lastCaptureText = null;
        this.emitExit({ code: null, signal: null });
    }

    private emitExit(exit: { code: number | null; signal: string | null }): void {
        for (const handler of this.exitHandlers) {
            handler(exit);
        }
    }
}

function runTmuxClientCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('tmux', args, {
            stdio: 'ignore',
            shell: false,
            env: sanitizeTmuxClientEnvironment(process.env),
        });
        let stderr = '';

        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `tmux exited with code ${code ?? 'unknown'}`));
        });
    });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
}

function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(done, 500);
        function done() {
            clearTimeout(timeout);
            child.off('exit', done);
            child.off('error', done);
            resolve();
        }
        child.once('exit', done);
        child.once('error', done);
    });
}

async function createTmuxLaunchScript(options: TerminalSpawnOptions, env: Record<string, string>): Promise<TmuxLaunchScript> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-claude-tmux-'));
    const scriptPath = join(dir, 'launch.sh');

    try {
        await chmod(dir, 0o700);
        await writeFile(scriptPath, buildHermeticLaunchScript(options, env, scriptPath, dir), { mode: 0o600 });
        await chmod(scriptPath, 0o600);
        return { dir, path: scriptPath };
    } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
}

async function cleanupTmuxLaunchScript(script: TmuxLaunchScript): Promise<void> {
    await rm(script.dir, { recursive: true, force: true });
}

function buildTmuxLaunchScriptCommand(scriptPath: string): string[] {
    return ['/bin/sh', quoteShellArg(scriptPath)];
}

function buildHermeticLaunchScript(
    options: TerminalSpawnOptions,
    env: Record<string, string>,
    scriptPath: string,
    scriptDir: string,
): string {
    const command = options.shell
        ? [env.SHELL || '/bin/sh', '-lc', options.command]
        : [options.command, ...(options.args ?? [])];
    const envAssignments = Object.entries(env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => quoteShellArg(`${key}=${value}`));
    const commandArgs = command.map(quoteShellArg);

    return [
        '#!/bin/sh',
        'set -u',
        `script_path=${quoteShellArg(scriptPath)}`,
        `script_dir=${quoteShellArg(scriptDir)}`,
        'cleanup() {',
        '    rm -f -- "$script_path" 2>/dev/null || true',
        '    rmdir -- "$script_dir" 2>/dev/null || true',
        '}',
        'trap cleanup EXIT HUP INT TERM',
        'cleanup',
        `exec env -i ${[...envAssignments, ...commandArgs].join(' ')}`,
        '',
    ].join('\n');
}

function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }

    return `'${value.replace(/'/g, "'\\''")}'`;
}

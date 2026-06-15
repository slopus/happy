import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
    TerminalDataHandler,
    TerminalExitHandler,
    TerminalSpawnOptions,
    TerminalTransport,
} from './terminalTransport';
import { sanitizeTerminalEnvironment } from './terminalEnvironment';

type PtyProcess = import('node-pty').IPty;
type PtyDisposable = { dispose(): void };

const requireForNodePty = createRequire(import.meta.url);

export class PtyTerminalTransport implements TerminalTransport {
    readonly backend = 'pty' as const;
    readonly capabilities = ['remote-control'] as const;

    terminalId: string | null = null;

    private ptyProcess: PtyProcess | null = null;
    private dataDisposable: PtyDisposable | null = null;
    private exitDisposable: PtyDisposable | null = null;
    private readonly dataHandlers = new Set<TerminalDataHandler>();
    private readonly exitHandlers = new Set<TerminalExitHandler>();

    async spawn(options: TerminalSpawnOptions): Promise<{ pid: number; terminalId: string }> {
        if (this.ptyProcess) {
            await this.dispose();
        }

        await ensureNodePtySpawnHelperExecutable();
        const nodePty = await import('node-pty');
        const env = sanitizeTerminalEnvironment(options.env);
        const command = options.shell ? (env.SHELL || '/bin/sh') : options.command;
        const args = options.shell ? ['-lc', options.command] : options.args;
        const ptyProcess = nodePty.spawn(command, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: options.cwd,
            env,
        });

        this.ptyProcess = ptyProcess;
        const terminalId = `pty:${ptyProcess.pid}`;
        this.terminalId = terminalId;
        this.dataDisposable = ptyProcess.onData((data) => {
            this.emitData(data);
        });
        this.exitDisposable = ptyProcess.onExit((event) => {
            this.disposePtyListeners();
            this.ptyProcess = null;
            this.terminalId = null;
            this.emitExit({
                code: event.exitCode,
                signal: normalizeExitSignal(event.signal),
            });
        });
        return { pid: ptyProcess.pid, terminalId };
    }

    async paste(text: string): Promise<void> {
        this.requirePty().write(text);
    }

    async enter(): Promise<void> {
        this.requirePty().write('\r');
    }

    async interrupt(): Promise<void> {
        this.requirePty().write('\x03');
    }

    async resize(cols: number, rows: number): Promise<void> {
        this.requirePty().resize(cols, rows);
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

    dispose(): void {
        const ptyProcess = this.ptyProcess;

        this.disposePtyListeners();
        this.ptyProcess = null;
        this.terminalId = null;
        this.dataHandlers.clear();
        this.exitHandlers.clear();

        if (ptyProcess) {
            ptyProcess.kill();
        }
    }

    private requirePty(): PtyProcess {
        if (!this.ptyProcess) {
            throw new Error('Pty terminal has not been spawned');
        }
        return this.ptyProcess;
    }

    private disposePtyListeners(): void {
        this.dataDisposable?.dispose();
        this.exitDisposable?.dispose();
        this.dataDisposable = null;
        this.exitDisposable = null;
    }

    private emitData(data: string): void {
        for (const handler of this.dataHandlers) {
            handler(data);
        }
    }

    private emitExit(exit: { code: number; signal: string | null }): void {
        for (const handler of this.exitHandlers) {
            handler(exit);
        }
    }
}

async function ensureNodePtySpawnHelperExecutable(): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    const packageRoot = dirname(dirname(requireForNodePty.resolve('node-pty')));
    const helperPath = await findNodePtySpawnHelper(packageRoot);
    if (helperPath === null) {
        return;
    }

    const helperStat = await stat(helperPath);
    if ((helperStat.mode & 0o111) !== 0) {
        return;
    }

    await chmod(helperPath, helperStat.mode | 0o111);
}

async function findNodePtySpawnHelper(packageRoot: string): Promise<string | null> {
    const candidates = [
        join(packageRoot, 'build', 'Release', 'spawn-helper'),
        join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];

    for (const candidate of candidates) {
        try {
            const entry = await stat(candidate);
            if (entry.isFile()) {
                return candidate;
            }
        } catch {
            // Try the next node-pty layout.
        }
    }

    return null;
}

function normalizeExitSignal(signal: number | string | null | undefined): string | null {
    if (signal === undefined || signal === null) {
        return null;
    }
    return String(signal);
}

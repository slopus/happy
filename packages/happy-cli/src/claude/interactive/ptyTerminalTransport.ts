import type {
    TerminalDataHandler,
    TerminalExitHandler,
    TerminalSpawnOptions,
    TerminalTransport,
} from './terminalTransport';

type PtyProcess = import('node-pty').IPty;
type PtyDisposable = { dispose(): void };

export class PtyTerminalTransport implements TerminalTransport {
    readonly backend = 'pty' as const;
    readonly capabilities = ['remote-control'] as const;

    terminalId?: string;

    private ptyProcess: PtyProcess | null = null;
    private dataDisposable: PtyDisposable | null = null;
    private exitDisposable: PtyDisposable | null = null;
    private readonly dataHandlers = new Set<TerminalDataHandler>();
    private readonly exitHandlers = new Set<TerminalExitHandler>();

    async spawn(options: TerminalSpawnOptions): Promise<void> {
        if (this.ptyProcess) {
            await this.dispose();
        }

        const nodePty = await import('node-pty');
        const command = options.shell ? (process.env.SHELL || '/bin/sh') : options.command;
        const args = options.shell ? ['-lc', options.command] : (options.args ?? []);
        const ptyProcess = nodePty.spawn(command, args, {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: options.cwd || process.cwd(),
            env: buildPtyEnv(options.env),
        });

        this.ptyProcess = ptyProcess;
        this.terminalId = `pty:${ptyProcess.pid}`;
        this.dataDisposable = ptyProcess.onData((data) => {
            this.emitData(data);
        });
        this.exitDisposable = ptyProcess.onExit((event) => {
            this.disposePtyListeners();
            this.ptyProcess = null;
            this.terminalId = undefined;
            this.emitExit({
                exitCode: event.exitCode,
                signal: event.signal ?? null,
            });
        });
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
        this.terminalId = undefined;
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

    private emitExit(exit: { exitCode: number; signal: number | null }): void {
        for (const handler of this.exitHandlers) {
            handler(exit);
        }
    }
}

function buildPtyEnv(env?: Record<string, string | undefined>): Record<string, string> {
    const merged: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            merged[key] = value;
        }
    }

    if (env) {
        for (const [key, value] of Object.entries(env)) {
            if (value !== undefined) {
                merged[key] = value;
            }
        }
    }

    return merged;
}

/**
 * node-pty backed shell session.
 *
 * Works on macOS, Linux and Windows (ConPTY). A headless xterm instance
 * mirrors all output so `snapshot()` can serialize the current screen
 * (including scrollback and alternate screen buffers) back to ANSI for a
 * client that attaches after the fact.
 */

import * as pty from 'node-pty';
import { createRequire } from 'node:module';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ShellSession } from './types';

const require = createRequire(import.meta.url);

// @xterm/headless is a CommonJS bundle whose namespace shape differs between
// runtime environments, so require it explicitly and keep a minimal local
// interface instead of depending on its ESM typings at runtime.
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as {
    Terminal: new (options: {
        cols: number;
        rows: number;
        scrollback: number;
        allowProposedApi?: boolean;
    }) => {
        write(data: string): void;
        resize(cols: number, rows: number): void;
        loadAddon(addon: unknown): void;
    };
};

export interface PtySessionOptions {
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
    env?: NodeJS.ProcessEnv;
    scrollback?: number;
}

type OutputListener = (data: string) => void;
type ExitListener = (exitCode: number) => void;
type ErrorListener = (error: Error) => void;

export class PtyShellSession implements ShellSession {
    readonly kind = 'pty' as const;

    private readonly process: pty.IPty;
    private readonly headless: InstanceType<typeof HeadlessTerminal>;
    private readonly serialize: SerializeAddon;
    private readonly outputListeners = new Set<OutputListener>();
    private readonly exitListeners = new Set<ExitListener>();
    private readonly errorListeners = new Set<ErrorListener>();
    private exited = false;
    private paused = false;

    constructor(options: PtySessionOptions) {
        this.headless = new HeadlessTerminal({
            cols: options.cols,
            rows: options.rows,
            scrollback: options.scrollback ?? 5000,
            allowProposedApi: true,
        });
        this.serialize = new SerializeAddon();
        this.headless.loadAddon(this.serialize);

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...options.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        };

        this.process = pty.spawn(options.shell, [], {
            name: 'xterm-256color',
            cols: options.cols,
            rows: options.rows,
            cwd: options.cwd,
            env,
        });

        this.process.onData((data) => {
            if (this.paused || this.exited) {
                return;
            }
            this.headless.write(data);
            for (const listener of this.outputListeners) {
                listener(data);
            }
        });

        this.process.onExit(({ exitCode }) => {
            if (this.exited) {
                return;
            }
            this.exited = true;
            for (const listener of this.exitListeners) {
                listener(exitCode);
            }
        });
    }

    write(data: string): void {
        if (!this.exited) {
            this.process.write(data);
        }
    }

    resize(cols: number, rows: number): void {
        this.process.resize(cols, rows);
        this.headless.resize(cols, rows);
    }

    pause(): void {
        if (this.paused || this.exited) {
            return;
        }
        this.paused = true;
        this.process.pause();
    }

    resume(): void {
        if (!this.paused || this.exited) {
            return;
        }
        this.paused = false;
        this.process.resume();
    }

    async snapshot(): Promise<string> {
        return this.serialize.serialize();
    }

    kill(): Promise<void> {
        if (this.exited) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            const onExit = () => {
                clearTimeout(timer);
                resolve();
            };
            this.exitListeners.add(onExit);
            try {
                this.process.kill();
            } catch {
                clearTimeout(timer);
                this.exitListeners.delete(onExit);
                resolve();
            }
        });
    }

    onOutput(listener: OutputListener): void {
        this.outputListeners.add(listener);
    }

    onExit(listener: ExitListener): void {
        this.exitListeners.add(listener);
    }

    onError(listener: ErrorListener): void {
        this.errorListeners.add(listener);
    }

    /** Not currently emitted by node-pty; kept for interface parity. */
    protected reportError(error: Error): void {
        for (const listener of this.errorListeners) {
            listener(error);
        }
    }
}

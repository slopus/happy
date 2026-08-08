/**
 * tmux-backed shell session using control mode (`tmux -C attach`).
 *
 * The shell runs inside a dedicated detached tmux session named
 * `happy-term-<terminalId>` so it survives daemon restarts. The daemon's
 * control-mode client streams `%output` notifications (octal-escaped) and
 * accepts tmux commands on stdin; raw terminal input is injected with
 * `send-keys -H <hex>` and the client size is set with `refresh-client -C`.
 * Screen snapshots come from `capture-pane -e -p`.
 */

import { execFile } from 'node:child_process';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { ShellSession } from './types';

const execFileAsync = promisify(execFile);

export interface TmuxSessionOptions {
    terminalId: string;
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
    env?: NodeJS.ProcessEnv;
}

type OutputListener = (data: string) => void;
type ExitListener = (exitCode: number) => void;
type ErrorListener = (error: Error) => void;

function tmuxTarget(terminalId: string): string {
    return `happy-term-${terminalId}`;
}

/** Unescape tmux control-mode octal escapes (`\015`, `\012`, `\033`, ...). */
export function unescapeControlOutput(input: string): string {
    let out = '';
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char !== '\\' || i + 3 >= input.length) {
            out += char;
            continue;
        }
        const octal = input.slice(i + 1, i + 4);
        if (/^[0-7]{3}$/.test(octal)) {
            out += String.fromCharCode(parseInt(octal, 8));
            i += 3;
        } else {
            out += char;
        }
    }
    return out;
}

export class TmuxShellSession implements ShellSession {
    readonly kind = 'tmux' as const;
    readonly tmuxTarget: string;

    private readonly child: ChildProcessWithoutNullStreams;
    private readonly paneId: string;
    private lineBuffer = '';
    private exited = false;
    private paused = false;
    private readonly outputListeners = new Set<OutputListener>();
    private readonly exitListeners = new Set<ExitListener>();
    private readonly errorListeners = new Set<ErrorListener>();
    private static readonly MAX_SEND_BYTES = 1024;

    private constructor(options: TmuxSessionOptions, paneId: string) {
        this.tmuxTarget = tmuxTarget(options.terminalId);
        this.paneId = paneId;

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...options.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        };

        this.child = spawn('tmux', ['-C', 'attach-session', '-t', this.tmuxTarget], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child.stdout.on('data', (chunk: Buffer) => {
            if (this.paused || this.exited) {
                return;
            }
            this.consume(chunk.toString('utf8'));
        });

        this.child.stderr.on('data', (chunk: Buffer) => {
            const message = chunk.toString('utf8').trim();
            if (message) {
                for (const listener of this.errorListeners) {
                    listener(new Error(message));
                }
            }
        });

        this.child.on('close', () => {
            this.handleExit();
        });
        this.child.on('error', (error) => {
            for (const listener of this.errorListeners) {
                listener(error);
            }
            this.handleExit();
        });
    }

    /** Create the detached tmux session if missing, then attach a control client. */
    static async create(options: TmuxSessionOptions): Promise<TmuxShellSession> {
        const target = tmuxTarget(options.terminalId);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...options.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        };

        try {
            await execFileAsync('tmux', ['has-session', '-t', target], { env });
        } catch {
            await execFileAsync(
                'tmux',
                ['new-session', '-d', '-s', target, '-c', options.cwd, options.shell],
                { env },
            );
        }

        const { stdout } = await execFileAsync(
            'tmux',
            ['list-panes', '-t', target, '-F', '#{pane_id}'],
            { env },
        );
        const paneId = stdout.trim();
        if (!/^%\d+$/.test(paneId)) {
            throw new Error(`Failed to resolve tmux pane for ${target}: ${paneId}`);
        }

        return new TmuxShellSession(options, paneId);
    }

    write(data: string): void {
        if (this.exited) {
            return;
        }
        const bytes = Buffer.from(data, 'utf8');
        for (let offset = 0; offset < bytes.length; offset += TmuxShellSession.MAX_SEND_BYTES) {
            const chunk = bytes.subarray(offset, offset + TmuxShellSession.MAX_SEND_BYTES);
            const hexKeys = Array.from(chunk, (byte) =>
                `0x${byte.toString(16).padStart(2, '0')}`);
            this.child.stdin.write(`send-keys -t ${this.paneId} -H ${hexKeys.join(' ')}\n`);
        }
    }

    resize(cols: number, rows: number): void {
        if (this.exited) {
            return;
        }
        this.child.stdin.write(`refresh-client -C ${cols}x${rows}\n`);
    }

    pause(): void {
        this.paused = true;
        if (!this.exited) {
            this.child.stdout.pause();
        }
    }

    resume(): void {
        this.paused = false;
        if (!this.exited) {
            this.child.stdout.resume();
        }
    }

    async snapshot(): Promise<string> {
        const { stdout } = await execFileAsync(
            'tmux',
            ['capture-pane', '-e', '-p', '-t', this.tmuxTarget],
            { maxBuffer: 4 * 1024 * 1024 },
        );
        return stdout;
    }

    kill(): Promise<void> {
        if (this.exited) {
            return Promise.resolve();
        }
        const done = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            this.exitListeners.add(() => {
                clearTimeout(timer);
                resolve();
            });
        });
        execFileAsync('tmux', ['kill-session', '-t', this.tmuxTarget]).catch(() => {
            // Session may already be gone; the child close handler resolves done().
        });
        this.child.kill();
        return done;
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

    private consume(chunk: string): void {
        this.lineBuffer += chunk;
        let newlineIndex: number;
        while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
            const line = this.lineBuffer.slice(0, newlineIndex);
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
            this.handleLine(line);
            if (this.exited) {
                return;
            }
        }
    }

    private handleLine(line: string): void {
        if (line.startsWith('%output ')) {
            const spaceIndex = line.indexOf(' ', 8);
            const paneId = spaceIndex === -1 ? '' : line.slice(8, spaceIndex);
            if (paneId !== this.paneId) {
                return;
            }
            const data = spaceIndex === -1 ? '' : unescapeControlOutput(line.slice(spaceIndex + 1));
            for (const listener of this.outputListeners) {
                listener(data);
            }
        } else if (line.startsWith('%exit')) {
            this.handleExit();
        }
    }

    private handleExit(): void {
        if (this.exited) {
            return;
        }
        this.exited = true;
        for (const listener of this.exitListeners) {
            listener(0);
        }
    }
}

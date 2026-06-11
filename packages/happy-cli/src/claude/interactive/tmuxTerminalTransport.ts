import {
    getTmuxUtilities,
    parseTmuxSessionIdentifier,
    type TmuxSessionIdentifier,
    type TmuxUtilities,
} from '@/utils/tmux';
import type {
    TerminalDataHandler,
    TerminalExitHandler,
    TerminalSpawnOptions,
    TerminalTransport,
} from './terminalTransport';

export class TmuxTerminalTransport implements TerminalTransport {
    readonly backend = 'tmux' as const;
    readonly capabilities = ['remote-control', 'local-attach'] as const;

    terminalId?: string;

    private readonly tmux: TmuxUtilities;
    private target?: TmuxSessionIdentifier;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private lastCaptureText: string | null = null;
    private readonly dataHandlers = new Set<TerminalDataHandler>();
    private readonly exitHandlers = new Set<TerminalExitHandler>();

    constructor(tmux: TmuxUtilities = getTmuxUtilities()) {
        this.tmux = tmux;
    }

    async spawn(options: TerminalSpawnOptions): Promise<void> {
        this.stopPolling();
        this.lastCaptureText = null;

        const result = await this.tmux.spawnInTmux(
            buildTmuxCommand(options),
            {
                cwd: options.cwd,
                windowName: options.windowName,
            },
            cleanEnv(options.env),
        );

        if (!result.success || !result.sessionId) {
            throw new Error(result.error || 'Failed to spawn command in tmux');
        }

        this.terminalId = result.sessionId;
        this.target = parseTmuxSessionIdentifier(result.sessionId);
        this.startPolling();
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
        this.stopPolling();
        this.dataHandlers.clear();
        this.exitHandlers.clear();

        const terminalId = this.terminalId;
        this.terminalId = undefined;
        this.target = undefined;
        this.lastCaptureText = null;

        if (terminalId) {
            await this.tmux.killWindow(terminalId);
        }
    }

    private requireTarget(): TmuxSessionIdentifier {
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
            const text = await this.tmux.capturePaneText(this.target.session, this.target.window, this.target.pane);
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
}

function buildTmuxCommand(options: TerminalSpawnOptions): string[] {
    if (options.shell) {
        return [options.command];
    }

    return [
        quoteShellArg(options.command),
        ...(options.args ?? []).map(quoteShellArg),
    ];
}

function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }

    return `'${value.replace(/'/g, "'\\''")}'`;
}

function cleanEnv(env?: Record<string, string | undefined>): Record<string, string> | undefined {
    if (!env) {
        return undefined;
    }

    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            cleaned[key] = value;
        }
    }

    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

import {
    getTmuxUtilities,
    parseTmuxSessionIdentifier,
    TmuxUtilities,
} from '@/utils/tmux';
import type {
    TerminalDataHandler,
    TerminalExitHandler,
    TerminalSpawnOptions,
    TerminalTransport,
} from './terminalTransport';

type TmuxPaneTarget = {
    session?: string;
    window?: string;
    pane?: string;
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
    private lastCaptureText: string | null = null;
    private readonly dataHandlers = new Set<TerminalDataHandler>();
    private readonly exitHandlers = new Set<TerminalExitHandler>();

    constructor(
        private readonly sessionName: string = TmuxUtilities.DEFAULT_SESSION_NAME,
        tmux: TmuxUtilities = getTmuxUtilities(sessionName),
    ) {
        this.tmux = tmux;
    }

    async spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }> {
        this.stopPolling();
        this.exited = false;
        this.lastCaptureText = null;
        this.cleanupTarget = null;

        const result = await this.tmux.spawnInTmux(
            buildTmuxCommand(options),
            {
                cwd: options.cwd,
                sessionName: this.sessionName,
                windowName: options.windowName,
            },
            filterTmuxEnvironment(options.env),
        );

        if (!result.success || !result.sessionId) {
            throw new Error(result.error || 'Failed to spawn command in tmux');
        }

        this.terminalId = result.sessionId;
        this.target = result.paneId ? { pane: result.paneId } : parseTmuxSessionIdentifier(result.sessionId);
        this.cleanupTarget = result.windowId ?? result.sessionId;
        this.startPolling();
        return { pid: result.pid, terminalId: result.sessionId };
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

const TMUX_ENV_ALLOWLIST = new Set(['NO_PROXY', 'no_proxy']);

function filterTmuxEnvironment(env: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (TMUX_ENV_ALLOWLIST.has(key)) {
            filtered[key] = value;
        }
    }

    return filtered;
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

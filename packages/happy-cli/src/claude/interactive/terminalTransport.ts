import type {
    InteractiveClaudeTerminalBackend,
    InteractiveClaudeTerminalCapability,
} from './types';

export interface TerminalSpawnOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    shell?: boolean;
    windowName?: string;
}

export interface TerminalExit {
    exitCode: number | null;
    signal?: number | string | null;
}

export type TerminalDataHandler = (data: string) => void;
export type TerminalExitHandler = (exit: TerminalExit) => void;

export interface TerminalTransport {
    readonly backend: InteractiveClaudeTerminalBackend;
    readonly capabilities: readonly InteractiveClaudeTerminalCapability[];
    readonly terminalId?: string;

    spawn(options: TerminalSpawnOptions): Promise<void>;
    paste(text: string): Promise<void>;
    enter(): Promise<void>;
    interrupt(): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    onData(handler: TerminalDataHandler): () => void;
    onExit(handler: TerminalExitHandler): () => void;
    dispose(): Promise<void> | void;
}

export interface TerminalBackendAvailability {
    tmux: {
        configured: boolean;
        available: boolean;
    };
    pty: {
        available: boolean;
    };
}

export type TerminalBackendSelection =
    | { supported: true; backend: InteractiveClaudeTerminalBackend }
    | { supported: false; backend: 'unsupported' };

export function chooseTerminalBackend(availability: TerminalBackendAvailability): TerminalBackendSelection {
    if (availability.tmux.configured && availability.tmux.available) {
        return { supported: true, backend: 'tmux' };
    }

    if (availability.pty.available) {
        return { supported: true, backend: 'pty' };
    }

    return { supported: false, backend: 'unsupported' };
}

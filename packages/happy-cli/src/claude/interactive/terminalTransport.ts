import type {
    InteractiveClaudeTerminalBackend,
    InteractiveClaudeTerminalCapability,
} from './types';

export interface TerminalSpawnOptions {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    shell?: boolean;
    windowName: string;
}

export interface TerminalExit {
    code: number | null;
    signal?: string | null;
}

export type TerminalDataHandler = (data: string) => void;
export type TerminalExitHandler = (exit: TerminalExit) => void;

export interface TerminalTransport {
    readonly backend: InteractiveClaudeTerminalBackend;
    readonly capabilities: readonly InteractiveClaudeTerminalCapability[];
    readonly terminalId: string | null;

    spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }>;
    paste(text: string): Promise<void>;
    enter(): Promise<void>;
    interrupt(): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    onData(handler: TerminalDataHandler): () => void;
    onExit(handler: TerminalExitHandler): () => void;
    dispose(): Promise<void> | void;
}

export interface TerminalBackendAvailability {
    tmuxConfigured: boolean;
    tmuxAvailable: boolean;
    ptyAvailable: boolean;
}

export type TerminalBackendSelection = InteractiveClaudeTerminalBackend | 'unsupported';

export function chooseTerminalBackend(availability: TerminalBackendAvailability): TerminalBackendSelection {
    if (availability.tmuxAvailable) {
        return 'tmux';
    }

    if (availability.ptyAvailable) {
        return 'pty';
    }

    return 'unsupported';
}

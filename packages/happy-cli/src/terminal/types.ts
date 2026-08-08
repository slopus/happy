/**
 * Types shared across the remote terminal subsystem.
 *
 * Terminals are first-class, daemon-owned entities: the daemon spawns the
 * shell (optionally inside a dedicated tmux session for restart persistence),
 * owns the authoritative output ring buffer, and relays encrypted frames to
 * and from the Happy server.
 */

export type TerminalStatus = 'pending' | 'running' | 'exited' | 'closed';

export type ApprovalPolicy = 'none' | 'once-per-machine' | 'per-session';

export interface TerminalRecord {
    terminalId: string;
    name: string;
    cwd: string;
    shell: string;
    status: TerminalStatus;
    /** tmux session name when the shell is tmux-backed (`happy-term-<id>`). */
    tmuxTarget?: string;
    /** Exact tmux pane id (`%0`) owned by this terminal, for split-pane safe recovery. */
    tmuxPaneId?: string;
    createdAt: number;
    lastAttachedAt?: number;
    exitCode?: number;
}

export interface TerminalCreateOptions {
    name?: string;
    cwd: string;
    shell?: string;
    cols: number;
    rows: number;
}

export type TerminalCreateResult =
    | { type: 'success'; terminalId: string }
    | { type: 'awaiting-approval'; approvalId: string; terminalId: string }
    | { type: 'error'; errorMessage: string };

export interface TerminalReplayFrame {
    seq: number;
    data: string;
}

export interface TerminalAttachResult {
    status: TerminalStatus;
    snapshot: string;
    nextSeq: number;
    truncated: boolean;
    /** Output frames generated while the client was detached (seq > lastSeq). */
    replayFrames: TerminalReplayFrame[];
    exitCode?: number;
}

export const TERMINAL_FRAME_VERSION = 1;

/**
 * Authenticated control frame carried inside the encrypted streaming payload.
 * The routing metadata (terminalId/machineId/streamId/direction) is bound to
 * the ciphertext so a compromised relay cannot cross-route or replay frames.
 */
export interface TerminalInputFrame {
    version: typeof TERMINAL_FRAME_VERSION;
    streamId: string;
    terminalId: string;
    machineId: string;
    direction: 'client-to-daemon';
    seq: number;
    kind: 'input' | 'resize' | 'signal';
    data?: string;
    cols?: number;
    rows?: number;
    signal?: string;
}

/**
 * Transport-agnostic output event produced by the terminal manager.
 * The wire layer (ApiMachineClient) binds routing metadata before encrypting.
 */
export interface TerminalOutputEvent {
    seq: number;
    kind: 'output' | 'exit' | 'error';
    data?: string;
    exitCode?: number;
    error?: string;
}

/** Authenticated output frame carried inside the encrypted streaming payload. */
export interface TerminalOutputFrame {
    version: typeof TERMINAL_FRAME_VERSION;
    streamId?: string;
    terminalId: string;
    machineId: string;
    direction: 'daemon-to-client';
    seq: number;
    kind: TerminalOutputEvent['kind'] | 'input-ack';
    data?: string;
    exitCode?: number;
    error?: string;
}

/**
 * A live shell backend. Two production implementations exist:
 * `PtyShellSession` (node-pty, every OS) and `TmuxShellSession`
 * (tmux control mode, restart-persistent).
 */
export interface ShellSession {
    readonly kind: 'pty' | 'tmux';
    readonly tmuxTarget?: string;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    pause(): void;
    resume(): void;
    snapshot(): Promise<string>;
    kill(): Promise<void>;
    onOutput(listener: (data: string) => void): void;
    onExit(listener: (exitCode: number) => void): void;
    onError(listener: (error: Error) => void): void;
}

export interface TerminalManagerEvents {
    output: (terminalId: string, frame: TerminalOutputEvent) => void;
    exit: (terminalId: string, frame: TerminalOutputEvent) => void;
    error: (terminalId: string, frame: TerminalOutputEvent) => void;
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
    return value === 'none' || value === 'once-per-machine' || value === 'per-session';
}

export function defaultShell(): string {
    return process.env.SHELL
        || (process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh');
}

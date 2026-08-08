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

/** Plaintext control frame carried inside the encrypted streaming payload. */
export interface TerminalInputFrame {
    seq: number;
    kind: 'input' | 'resize' | 'signal';
    data?: string;
    cols?: number;
    rows?: number;
    signal?: string;
}

/** Plaintext output frame carried inside the encrypted streaming payload. */
export interface TerminalOutputFrame {
    seq: number;
    kind: 'output' | 'exit' | 'error' | 'input-ack';
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
    output: (terminalId: string, frame: TerminalOutputFrame) => void;
    exit: (terminalId: string, frame: TerminalOutputFrame) => void;
    error: (terminalId: string, frame: TerminalOutputFrame) => void;
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
    return value === 'none' || value === 'once-per-machine' || value === 'per-session';
}

export function defaultShell(): string {
    return process.env.SHELL
        || (process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh');
}

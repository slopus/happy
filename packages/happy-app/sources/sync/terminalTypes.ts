/**
 * Types for the remote terminal feature (daemon-owned persistent shells).
 * Wire shapes mirror `happy-cli/src/terminal/types.ts`.
 */

export type RemoteTerminalStatus = 'pending' | 'running' | 'exited' | 'closed';

export type TerminalApprovalPolicy = 'none' | 'once-per-machine' | 'per-session';

export interface RemoteTerminal {
    terminalId: string;
    name: string;
    cwd: string;
    shell: string;
    status: RemoteTerminalStatus;
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
    status: RemoteTerminalStatus;
    snapshot: string;
    nextSeq: number;
    truncated: boolean;
    replayFrames: TerminalReplayFrame[];
    exitCode?: number;
}

/** Encrypted streaming frame payload (client → daemon). */
export interface TerminalInputFrame {
    seq: number;
    kind: 'input' | 'resize' | 'signal';
    data?: string;
    cols?: number;
    rows?: number;
    signal?: string;
}

/** Encrypted streaming frame payload (daemon → client). */
export interface TerminalOutputFrame {
    seq: number;
    kind: 'output' | 'exit' | 'error' | 'input-ack';
    data?: string;
    exitCode?: number;
    error?: string;
}

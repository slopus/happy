/**
 * Remote terminal client: control RPCs plus the encrypted streaming plane.
 *
 * Control methods (`terminal-create`, `terminal-approve`, `terminal-attach`,
 * `terminal-list`, `terminal-close`, `terminal-set-policy`) ride the existing
 * machine-scoped RPC transport. Streaming frames travel over Socket.IO events
 * relayed by the server; all payloads are encrypted with the machine key, so
 * the server never sees terminal content.
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import * as Crypto from 'expo-crypto';
import type { MachineEncryption } from './encryption/machineEncryption';
import { TERMINAL_FRAME_VERSION } from './terminalTypes';
import type {
    RemoteTerminal,
    TerminalApprovalPolicy,
    TerminalAttachResult,
    TerminalCreateOptions,
    TerminalCreateResult,
    TerminalInputFrame,
    TerminalOutputFrame,
} from './terminalTypes';

export type {
    RemoteTerminal,
    TerminalApprovalPolicy,
    TerminalAttachResult,
    TerminalCreateOptions,
    TerminalCreateResult,
    TerminalInputFrame,
    TerminalOutputFrame,
} from './terminalTypes';

export async function terminalList(machineId: string): Promise<RemoteTerminal[]> {
    return apiSocket.machineRPC<RemoteTerminal[], Record<string, never>>(
        machineId,
        'terminal-list',
        {},
    );
}

export async function terminalCreate(
    machineId: string,
    options: TerminalCreateOptions,
): Promise<TerminalCreateResult> {
    return apiSocket.machineRPC<TerminalCreateResult, TerminalCreateOptions>(
        machineId,
        'terminal-create',
        options,
    );
}

export async function terminalApprove(
    machineId: string,
    approvalId: string,
): Promise<TerminalCreateResult> {
    return apiSocket.machineRPC<TerminalCreateResult, { approvalId: string }>(
        machineId,
        'terminal-approve',
        { approvalId },
    );
}

export async function terminalAttach(
    machineId: string,
    terminalId: string,
    lastSeq = 0,
): Promise<TerminalAttachResult> {
    return apiSocket.machineRPC<TerminalAttachResult, { terminalId: string; lastSeq: number }>(
        machineId,
        'terminal-attach',
        { terminalId, lastSeq },
    );
}

export async function terminalClose(
    machineId: string,
    terminalId: string,
): Promise<{ success: boolean }> {
    return apiSocket.machineRPC<{ success: boolean }, { terminalId: string }>(
        machineId,
        'terminal-close',
        { terminalId },
    );
}

export async function terminalSetPolicy(
    machineId: string,
    policy: TerminalApprovalPolicy,
): Promise<{ policy: TerminalApprovalPolicy }> {
    return apiSocket.machineRPC<{ policy: TerminalApprovalPolicy }, { policy: TerminalApprovalPolicy }>(
        machineId,
        'terminal-set-policy',
        { policy },
    );
}

export async function terminalGetPolicy(
    machineId: string,
): Promise<{ policy: TerminalApprovalPolicy }> {
    return apiSocket.machineRPC<{ policy: TerminalApprovalPolicy }, Record<string, never>>(
        machineId,
        'terminal-get-policy',
        {},
    );
}

function getMachineEncryption(machineId: string): MachineEncryption {
    const encryption = sync.encryption.getMachineEncryption(machineId);
    if (!encryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }
    return encryption;
}

export type TerminalStreamStatus =
    | 'connecting'
    | 'attached'
    | 'reconnecting'
    | 'exited'
    | 'error'
    | 'detached';

export interface TerminalStreamHandlers {
    onAttach(result: TerminalAttachResult): void;
    onOutput(data: string): void;
    onExit(exitCode: number): void;
    onError(message: string): void;
    onWriter(writerSocketId: string): void;
    onStatusChange(status: TerminalStreamStatus): void;
}

/**
 * One live terminal connection.
 *
 * Ordering guarantees:
 * - subscribe BEFORE attach, so live frames are delivered while the snapshot
 *   RPC is in flight; they are buffered and applied after snapshot + replay
 *   against the attach barrier seq;
 * - output frames are only accepted when `seq === lastSeq + 1`; any gap
 *   triggers a resync instead of silent corruption;
 * - every encrypted frame binds streamId/terminalId/machineId/direction, so a
 *   relay cannot cross-route or replay a frame;
 * - input frames are acked per stream and re-sent in order after reconnect
 *   only while unacked; the daemon dedupes by stream seq.
 */
export class TerminalStream {
    readonly streamId: string;
    private lastOutputSeq = 0;
    private inputSeq = 0;
    private readonly unackedInputs = new Map<number, string>();
    private readonly disposers: Array<() => void> = [];
    private wired = false;
    private status: TerminalStreamStatus = 'connecting';
    private attaching = false;
    private bufferedFrames: Array<{ seq: number; data: string }> = [];
    private resyncAttempts = 0;
    private static readonly MAX_RESYNC_ATTEMPTS = 3;

    constructor(
        private readonly machineId: string,
        private readonly terminalId: string,
        private readonly handlers: TerminalStreamHandlers,
    ) {
        this.streamId = Crypto.randomUUID();
    }

    async attach(): Promise<TerminalAttachResult> {
        this.resyncAttempts = 0;
        return this.performAttach();
    }

    private async performAttach(): Promise<TerminalAttachResult> {
        this.setStatus('connecting');
        if (!this.wired) {
            this.wireSocketEvents();
            this.wired = true;
        }
        this.attaching = true;
        this.bufferedFrames = [];

        try {
            // Subscribe first: any output produced while the attach RPC is in
            // flight reaches this client and is buffered, closing the window
            // between replay capture and live subscription.
            apiSocket.send('terminal:subscribe', { terminalId: this.terminalId });
            const result = await terminalAttach(this.machineId, this.terminalId, this.lastOutputSeq);
            this.handlers.onAttach(result);

            if (result.status === 'running') {
                const gap = this.applyAttachBarrier(result);
                if (gap) {
                    await this.resync();
                } else {
                    this.takeControl();
                    await this.resendUnackedInputs();
                    this.setStatus('attached');
                }
            } else if (result.status === 'exited') {
                this.setStatus('exited');
                this.handlers.onExit(result.exitCode ?? 0);
            }
            return result;
        } finally {
            this.attaching = false;
            this.bufferedFrames = [];
        }
    }

    async sendInput(data: string): Promise<void> {
        const seq = ++this.inputSeq;
        this.unackedInputs.set(seq, data);
        const payload = await this.encrypt<TerminalInputFrame>(
            this.inputFrame({ seq, kind: 'input', data }),
        );
        apiSocket.send('terminal:input', { terminalId: this.terminalId, payload });
    }

    async sendResize(cols: number, rows: number): Promise<void> {
        const seq = ++this.inputSeq;
        const payload = await this.encrypt<TerminalInputFrame>(
            this.inputFrame({ seq, kind: 'resize', cols, rows }),
        );
        apiSocket.send('terminal:resize', { terminalId: this.terminalId, payload });
    }

    takeControl(): void {
        apiSocket.send('terminal:takeover', { terminalId: this.terminalId });
    }

    detach(): void {
        for (const dispose of this.disposers.splice(0)) {
            dispose();
        }
        this.wired = false;
        this.attaching = false;
        this.bufferedFrames = [];
        this.resyncAttempts = 0;
        apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
        this.setStatus('detached');
    }

    private wireSocketEvents(): void {
        this.disposers.push(apiSocket.onMessage('terminal:output', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            void this.handleOutputFrame(data.payload);
        }));

        this.disposers.push(apiSocket.onMessage('terminal:exit', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            void this.handleExitFrame(data.payload);
        }));

        this.disposers.push(apiSocket.onMessage('terminal:input-ack', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            void this.handleInputAckFrame(data.payload);
        }));

        this.disposers.push(apiSocket.onMessage('terminal:writer', (data: any) => {
            if (data?.terminalId === this.terminalId && typeof data.writerSocketId === 'string') {
                this.handlers.onWriter(data.writerSocketId);
            }
        }));

        this.disposers.push(apiSocket.onReconnected(() => {
            void this.resync();
        }));
    }

    private async handleOutputFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isValidOutputFrame(frame) || frame.kind !== 'output') {
            return;
        }
        if (this.attaching) {
            if (frame.seq > this.lastOutputSeq) {
                this.bufferedFrames.push({ seq: frame.seq, data: frame.data ?? '' });
            }
            return;
        }
        if (frame.seq <= this.lastOutputSeq) {
            return;
        }
        if (frame.seq !== this.lastOutputSeq + 1) {
            // Missing frames would silently corrupt TUI state: resync instead.
            void this.resync();
            return;
        }
        this.lastOutputSeq = frame.seq;
        if (frame.data) {
            this.handlers.onOutput(frame.data);
        }
    }

    private async handleExitFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isValidOutputFrame(frame) || frame.kind !== 'exit') {
            return;
        }
        this.setStatus('exited');
        this.handlers.onExit(frame.exitCode ?? 0);
    }

    private async handleInputAckFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isValidOutputFrame(frame)
            || frame.kind !== 'input-ack'
            || frame.streamId !== this.streamId) {
            return;
        }
        this.unackedInputs.delete(frame.seq);
    }

    private async resync(): Promise<void> {
        if (this.resyncAttempts >= TerminalStream.MAX_RESYNC_ATTEMPTS) {
            this.setStatus('error');
            this.handlers.onError(
                'Connection is unstable; terminal output may be incomplete. Reconnecting…',
            );
            return;
        }
        this.resyncAttempts++;
        this.setStatus('reconnecting');
        try {
            await this.performAttach();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus('error');
            this.handlers.onError(message);
        }
    }

    /**
     * Apply snapshot/replay against the attach barrier, then drain buffered
     * live frames in order. Returns true when a frame gap was found (the
     * caller must resync); resets the resync budget on a clean barrier.
     */
    private applyAttachBarrier(result: TerminalAttachResult): boolean {
        this.lastOutputSeq = result.nextSeq - 1;
        const ordered = [...this.bufferedFrames]
            .filter((frame) => frame.seq > this.lastOutputSeq)
            .sort((a, b) => a.seq - b.seq);

        let expected = result.nextSeq;
        for (const frame of ordered) {
            if (frame.seq < expected) {
                continue; // Already covered by replayFrames.
            }
            if (frame.seq !== expected) {
                return true; // Gap in the live stream.
            }
            this.lastOutputSeq = frame.seq;
            if (frame.data) {
                this.handlers.onOutput(frame.data);
            }
            expected = frame.seq + 1;
        }
        this.resyncAttempts = 0;
        return false;
    }

    private async resendUnackedInputs(): Promise<void> {
        const pending = Array.from(this.unackedInputs.entries())
            .sort(([a], [b]) => a - b);
        for (const [seq, data] of pending) {
            const payload = await this.encrypt<TerminalInputFrame>(
                this.inputFrame({ seq, kind: 'input', data }),
            );
            apiSocket.send('terminal:input', { terminalId: this.terminalId, payload });
        }
    }

    private inputFrame(partial: {
        seq: number;
        kind: TerminalInputFrame['kind'];
        data?: string;
        cols?: number;
        rows?: number;
        signal?: string;
    }): TerminalInputFrame {
        return {
            version: TERMINAL_FRAME_VERSION,
            streamId: this.streamId,
            terminalId: this.terminalId,
            machineId: this.machineId,
            direction: 'client-to-daemon',
            ...partial,
        };
    }

    private isValidOutputFrame(frame: TerminalOutputFrame | null): frame is TerminalOutputFrame {
        return !!frame
            && frame.version === TERMINAL_FRAME_VERSION
            && frame.direction === 'daemon-to-client'
            && frame.terminalId === this.terminalId
            && frame.machineId === this.machineId
            && Number.isSafeInteger(frame.seq)
            && frame.seq > 0;
    }

    private async encrypt<T>(frame: T): Promise<string> {
        return getMachineEncryption(this.machineId).encryptRaw(frame);
    }

    private async decrypt<T>(payload: string): Promise<T | null> {
        return getMachineEncryption(this.machineId).decryptRaw(payload) as T | null;
    }

    private setStatus(status: TerminalStreamStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.handlers.onStatusChange(status);
        }
    }
}

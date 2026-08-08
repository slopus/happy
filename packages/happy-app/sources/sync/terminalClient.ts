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
    /** Daemon restarted while this stream was connected; queued input dropped. */
    onEpochReset?(): void;
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
    private controlStreamId: string;
    private streamEpoch = '';
    private lastOutputSeq = 0;
    private inputSeq = 0;
    private readonly unackedInputs = new Map<number, string>();
    private readonly disposers: Array<() => void> = [];
    private wired = false;
    private status: TerminalStreamStatus = 'connecting';
    private attaching = false;
    private bufferedFrames: Array<{ epoch: string; seq: number; data: string }> = [];
    private inboundQueue: Promise<void> = Promise.resolve();
    private attachInFlight: Promise<TerminalAttachResult> | null = null;
    private lastNotifiedEpoch = '';
    private resyncAttempts = 0;
    private static readonly MAX_RESYNC_ATTEMPTS = 3;

    constructor(
        private readonly machineId: string,
        private readonly terminalId: string,
        private readonly handlers: TerminalStreamHandlers,
    ) {
        this.controlStreamId = Crypto.randomUUID();
    }

    get streamId(): string {
        return this.controlStreamId;
    }

    async attach(): Promise<TerminalAttachResult> {
        this.resyncAttempts = 0;
        return this.ensureAttached();
    }

    private ensureAttached(): Promise<TerminalAttachResult> {
        if (this.attachInFlight) {
            return this.attachInFlight;
        }
        const attachPromise = this.performAttachWithRetries().finally(() => {
            if (this.attachInFlight === attachPromise) {
                this.attachInFlight = null;
            }
        });
        this.attachInFlight = attachPromise;
        return attachPromise;
    }

    private async performAttachWithRetries(): Promise<TerminalAttachResult> {
        while (true) {
            const { result, gap } = await this.performAttach();
            if (!gap) {
                return result;
            }
            if (this.resyncAttempts >= TerminalStream.MAX_RESYNC_ATTEMPTS) {
                throw new Error('Connection is unstable; terminal output may be incomplete. Reconnecting…');
            }
            this.resyncAttempts++;
            this.setStatus('reconnecting');
        }
    }

    private async performAttach(): Promise<{ result: TerminalAttachResult; gap: boolean }> {
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

            // Daemon generation changed (daemon restarted, tmux kept running):
            // old unacked input may already have executed, so it is dropped
            // (at-most-once) instead of being re-sent and run twice.
            this.acceptEpoch(result.streamEpoch);
            this.handlers.onAttach(result);

            if (result.status === 'running') {
                const gap = this.applyAttachBarrier(result);
                if (gap) {
                    return { result, gap: true };
                }
                // From here on, frames are handled live: anything arriving
                // during takeover/resend must not be buffered and dropped.
                this.attaching = false;
                this.takeControl();
                await this.resendUnackedInputs();
                this.setStatus('attached');
            } else if (result.status === 'exited') {
                this.setStatus('exited');
                this.handlers.onExit(result.exitCode ?? 0);
            }
            return { result, gap: false };
        } finally {
            this.attaching = false;
            this.bufferedFrames = [];
        }
    }

    async sendInput(data: string): Promise<void> {
        const seq = ++this.inputSeq;
        this.unackedInputs.set(seq, data);
        const frame = this.inputFrame({ seq, kind: 'input', data });
        const payload = await this.encrypt<TerminalInputFrame>(frame);
        if (frame.epoch !== this.streamEpoch || frame.streamId !== this.streamId) {
            this.unackedInputs.delete(seq);
            return;
        }
        apiSocket.send('terminal:input', { terminalId: this.terminalId, payload });
    }

    async sendResize(cols: number, rows: number): Promise<void> {
        const seq = ++this.inputSeq;
        const frame = this.inputFrame({ seq, kind: 'resize', cols, rows });
        const payload = await this.encrypt<TerminalInputFrame>(frame);
        if (frame.epoch !== this.streamEpoch || frame.streamId !== this.streamId) {
            return;
        }
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
        this.streamEpoch = '';
        apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
        this.setStatus('detached');
    }

    private wireSocketEvents(): void {
        this.disposers.push(apiSocket.onMessage('terminal:output', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound(() => this.handleOutputFrame(data.payload));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:exit', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound(() => this.handleExitFrame(data.payload));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:input-ack', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound(() => this.handleInputAckFrame(data.payload));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:epoch', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound(() => this.handleEpochFrame(data.payload));
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
        if (!this.isValidOutputFrame(frame)) {
            return;
        }
        if (frame.kind === 'error') {
            if (frame.epoch === this.streamEpoch) {
                this.handlers.onError(frame.error ?? 'Terminal error');
            }
            return;
        }
        if (frame.kind !== 'output') {
            return;
        }
        if (this.attaching) {
            this.bufferedFrames.push({
                epoch: frame.epoch,
                seq: frame.seq,
                data: frame.data ?? '',
            });
            return;
        }
        if (frame.epoch !== this.streamEpoch) {
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
        if (!this.isValidOutputFrame(frame)
            || frame.kind !== 'exit'
            || frame.epoch !== this.streamEpoch) {
            return;
        }
        if (frame.seq !== this.lastOutputSeq + 1) {
            if (frame.seq > this.lastOutputSeq + 1) {
                void this.resync();
            }
            return;
        }
        this.lastOutputSeq = frame.seq;
        this.setStatus('exited');
        this.handlers.onExit(frame.exitCode ?? 0);
    }

    private async handleInputAckFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isValidOutputFrame(frame)
            || frame.kind !== 'input-ack'
            || frame.epoch !== this.streamEpoch
            || frame.streamId !== this.streamId) {
            return;
        }
        this.unackedInputs.delete(frame.seq);
    }

    private async handleEpochFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isValidOutputFrame(frame) || frame.kind !== 'epoch') {
            return;
        }
        if (!this.acceptEpoch(frame.epoch)) {
            return;
        }
        await this.resync();
    }

    private async resync(): Promise<void> {
        this.setStatus('reconnecting');
        try {
            await this.ensureAttached();
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
            .filter((frame) => frame.epoch === this.streamEpoch && frame.seq > this.lastOutputSeq)
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
            epoch: this.streamEpoch,
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
            && typeof frame.epoch === 'string'
            && frame.epoch.length > 0
            && Number.isSafeInteger(frame.seq)
            && (frame.kind === 'epoch' ? frame.seq === 0 : frame.seq > 0);
    }

    private acceptEpoch(epoch: string): boolean {
        if (!epoch || epoch === this.streamEpoch) {
            return false;
        }
        const previousEpoch = this.streamEpoch;
        this.streamEpoch = epoch;
        if (!previousEpoch) {
            return false;
        }

        this.unackedInputs.clear();
        this.inputSeq = 0;
        this.controlStreamId = Crypto.randomUUID();
        if (this.lastNotifiedEpoch !== epoch) {
            this.lastNotifiedEpoch = epoch;
            this.handlers.onEpochReset?.();
        }
        return true;
    }

    private enqueueInbound(operation: () => Promise<void>): void {
        const next = this.inboundQueue.then(operation);
        this.inboundQueue = next.catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.handlers.onError(message);
        });
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

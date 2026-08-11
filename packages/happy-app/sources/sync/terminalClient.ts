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
    onWriter(state: TerminalWriterState): void;
    /** Daemon restarted while this stream was connected; queued input dropped. */
    onEpochReset?(): void;
    /** Control sequence could not be repaired; destructive controls were dropped. */
    onControlReset?(): void;
    onStatusChange(status: TerminalStreamStatus): void;
}

export interface TerminalWriterState {
    writerSocketId: string | null;
    generation: number;
    isWriter: boolean;
}

type TerminalControlEvent = 'terminal:input' | 'terminal:resize' | 'terminal:signal';

interface PendingTerminalControl {
    seq: number;
    kind: TerminalInputFrame['kind'];
    event: TerminalControlEvent;
    payload: string;
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
    private controlSeq = 0;
    private readonly pendingControls = new Map<number, PendingTerminalControl>();
    private desiredSize: { cols: number; rows: number } | null = null;
    private desiredSizeDirty = false;
    private readonly disposers: Array<() => void> = [];
    private wired = false;
    private status: TerminalStreamStatus = 'connecting';
    private attaching = false;
    private bufferedFrames: Array<{ epoch: string; seq: number; data: string }> = [];
    private bufferedFrameBytes = 0;
    private attachBufferOverflowed = false;
    private inboundQueue: Promise<void> = Promise.resolve();
    private outboundQueue: Promise<void> = Promise.resolve();
    private attachInFlight: Promise<TerminalAttachResult> | null = null;
    private lastNotifiedEpoch = '';
    private currentWriterSocketId: string | null = null;
    private writerGeneration = 0;
    private writerStateInitialized = false;
    private writer = false;
    private controlReady = false;
    private resyncAttempts = 0;
    private lifecycleGeneration = 0;
    private detached = false;
    private static readonly MAX_RESYNC_ATTEMPTS = 3;
    private static readonly MAX_ATTACH_BUFFER_BYTES = 512 * 1024;

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

    get isWriter(): boolean {
        return this.writer;
    }

    async attach(): Promise<TerminalAttachResult> {
        if (this.detached) {
            this.detached = false;
            this.lifecycleGeneration++;
        }
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
        const lifecycleGeneration = this.lifecycleGeneration;
        this.setStatus('connecting');
        this.controlReady = false;
        if (!this.wired) {
            this.wireSocketEvents();
            this.wired = true;
        }
        this.attaching = true;
        this.bufferedFrames = [];
        this.bufferedFrameBytes = 0;
        this.attachBufferOverflowed = false;

        try {
            // Subscribe first: any output produced while the attach RPC is in
            // flight reaches this client and is buffered, closing the window
            // between replay capture and live subscription.
            const writerState = await apiSocket.emitWithAck<TerminalWriterState>(
                'terminal:subscribe',
                { terminalId: this.terminalId },
            );
            if (!this.isLifecycleCurrent(lifecycleGeneration)) {
                apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
                throw new Error('Terminal stream detached during subscribe');
            }
            this.applyWriterState(writerState);
            const result = await terminalAttach(this.machineId, this.terminalId, this.lastOutputSeq);
            if (!this.isLifecycleCurrent(lifecycleGeneration)) {
                apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
                return { result, gap: false };
            }

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
                this.controlReady = true;
                if (this.isWriter) {
                    await this.enqueueOutbound(async () => {
                        await this.resendPendingControls();
                        await this.sendDesiredResizeIfNeeded();
                    }, lifecycleGeneration);
                }
                if (!this.isLifecycleCurrent(lifecycleGeneration)) {
                    return { result, gap: false };
                }
                this.setStatus('attached');
            } else if (result.status === 'exited') {
                this.controlReady = false;
                this.setStatus('exited');
                this.handlers.onExit(result.exitCode ?? 0);
            }
            return { result, gap: false };
        } finally {
            if (this.isLifecycleCurrent(lifecycleGeneration)) {
                this.attaching = false;
                this.bufferedFrames = [];
                this.bufferedFrameBytes = 0;
                this.attachBufferOverflowed = false;
            }
        }
    }

    async sendInput(data: string): Promise<void> {
        await this.enqueueOutbound(async () => {
            if (!this.canSendControls()) {
                return;
            }
            await this.createAndSendControl('terminal:input', {
                kind: 'input',
                data,
            });
        });
    }

    async sendResize(cols: number, rows: number): Promise<void> {
        const desiredSize = { cols, rows };
        this.desiredSize = desiredSize;
        this.desiredSizeDirty = true;
        await this.enqueueOutbound(async () => {
            if (this.desiredSize !== desiredSize || !this.canSendControls()) {
                return;
            }
            await this.sendDesiredResizeIfNeeded();
        });
    }

    async sendSignal(signal: string): Promise<void> {
        await this.enqueueOutbound(async () => {
            if (!this.canSendControls()) {
                return;
            }
            await this.createAndSendControl('terminal:signal', {
                kind: 'signal',
                signal,
            });
        });
    }

    async takeControl(): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        const state = await apiSocket.emitWithAck<TerminalWriterState>(
            'terminal:takeover',
            { terminalId: this.terminalId },
        );
        if (this.isLifecycleCurrent(lifecycleGeneration)) {
            this.applyWriterState(state);
        } else {
            // The server may have granted the seat after this screen closed.
            // Release it again so other viewers are not left view-only.
            apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
        }
    }

    detach(): void {
        this.detached = true;
        this.lifecycleGeneration++;
        this.attachInFlight = null;
        for (const dispose of this.disposers.splice(0)) {
            dispose();
        }
        this.wired = false;
        this.attaching = false;
        this.bufferedFrames = [];
        this.bufferedFrameBytes = 0;
        this.attachBufferOverflowed = false;
        this.resyncAttempts = 0;
        this.streamEpoch = '';
        this.writer = false;
        this.writerStateInitialized = false;
        this.currentWriterSocketId = null;
        this.writerGeneration = 0;
        this.controlReady = false;
        this.rotateControlStream();
        apiSocket.send('terminal:unsubscribe', { terminalId: this.terminalId });
        this.setStatus('detached');
    }

    private wireSocketEvents(): void {
        this.disposers.push(apiSocket.onMessage('terminal:output', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound((generation) => this.handleOutputFrame(data.payload, generation));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:exit', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound((generation) => this.handleExitFrame(data.payload, generation));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:control-ack', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound((generation) => this.handleControlAckFrame(data.payload, generation));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:control-nack', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound((generation) => this.handleControlNackFrame(data.payload, generation));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:epoch', (data: any) => {
            if (data?.terminalId !== this.terminalId || typeof data.payload !== 'string') {
                return;
            }
            this.enqueueInbound((generation) => this.handleEpochFrame(data.payload, generation));
        }));

        this.disposers.push(apiSocket.onMessage('terminal:writer', (data: any) => {
            if (data?.terminalId === this.terminalId
                && (typeof data.writerSocketId === 'string' || data.writerSocketId === null)
                && Number.isSafeInteger(data.generation)) {
                this.applyWriterState({
                    writerSocketId: data.writerSocketId,
                    generation: data.generation,
                    isWriter: data.writerSocketId !== null
                        && data.writerSocketId === apiSocket.getSocketId(),
                });
            }
        }));

        this.disposers.push(apiSocket.onReconnected(() => {
            void this.resync();
        }));
    }

    private async handleOutputFrame(payload: string, generation: number): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isLifecycleCurrent(generation) || !this.isValidOutputFrame(frame)) {
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
            const data = frame.data ?? '';
            const nextBytes = this.bufferedFrameBytes + data.length;
            if (nextBytes > TerminalStream.MAX_ATTACH_BUFFER_BYTES) {
                this.attachBufferOverflowed = true;
                this.bufferedFrames = [];
                this.bufferedFrameBytes = 0;
                return;
            }
            if (this.attachBufferOverflowed) {
                return;
            }
            this.bufferedFrames.push({
                epoch: frame.epoch,
                seq: frame.seq,
                data,
            });
            this.bufferedFrameBytes = nextBytes;
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

    private async handleExitFrame(payload: string, generation: number): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isLifecycleCurrent(generation)
            || !this.isValidOutputFrame(frame)
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

    private async handleControlAckFrame(payload: string, generation: number): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isLifecycleCurrent(generation)
            || !this.isValidOutputFrame(frame)
            || frame.kind !== 'control-ack'
            || frame.epoch !== this.streamEpoch
            || frame.streamId !== this.streamId
            || (frame.status !== 'applied' && frame.status !== 'duplicate')) {
            return;
        }
        this.pendingControls.delete(frame.seq);
    }

    private async handleControlNackFrame(payload: string, generation: number): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isLifecycleCurrent(generation)
            || !this.isValidOutputFrame(frame)
            || frame.kind !== 'control-nack'
            || frame.epoch !== this.streamEpoch
            || frame.streamId !== this.streamId
            || (frame.reason !== 'gap' && frame.reason !== 'invalid')
            || !Number.isSafeInteger(frame.expectedSeq)
            || (frame.expectedSeq ?? 0) <= 0) {
            return;
        }
        await this.enqueueOutbound(async () => {
            await this.resendPendingControls(frame.expectedSeq);
        });
    }

    private async handleEpochFrame(payload: string, generation: number): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!this.isLifecycleCurrent(generation)
            || !this.isValidOutputFrame(frame)
            || frame.kind !== 'epoch') {
            return;
        }
        if (!this.acceptEpoch(frame.epoch)) {
            return;
        }
        await this.resync();
    }

    private async resync(): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isLifecycleCurrent(lifecycleGeneration)) {
            return;
        }
        this.setStatus('reconnecting');
        try {
            await this.ensureAttached();
        } catch (error) {
            if (!this.isLifecycleCurrent(lifecycleGeneration)) {
                return;
            }
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
        if (this.attachBufferOverflowed) {
            return true;
        }
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

    private canSendControls(): boolean {
        return this.controlReady
            && this.isWriter
            && this.streamEpoch.length > 0;
    }

    private async createAndSendControl(
        event: TerminalControlEvent,
        partial: {
            kind: TerminalInputFrame['kind'];
            data?: string;
            cols?: number;
            rows?: number;
            signal?: string;
        },
    ): Promise<boolean> {
        if (!this.canSendControls()) {
            return false;
        }
        const seq = ++this.controlSeq;
        const frame = this.inputFrame({ seq, ...partial });
        let payload: string;
        try {
            payload = await this.encrypt<TerminalInputFrame>(frame);
        } catch (error) {
            if (frame.epoch === this.streamEpoch
                && frame.streamId === this.streamId
                && this.controlSeq === seq) {
                this.controlSeq--;
            }
            throw error;
        }
        if (!this.canSendControls()
            || frame.epoch !== this.streamEpoch
            || frame.streamId !== this.streamId) {
            if (frame.epoch === this.streamEpoch
                && frame.streamId === this.streamId
                && this.controlSeq === seq) {
                this.controlSeq--;
            }
            return false;
        }

        const control: PendingTerminalControl = {
            seq,
            kind: frame.kind,
            event,
            payload,
        };
        this.pendingControls.set(seq, control);
        this.emitPendingControl(control);
        return true;
    }

    private async sendDesiredResizeIfNeeded(): Promise<void> {
        const desiredSize = this.desiredSize;
        if (!desiredSize || !this.desiredSizeDirty || !this.canSendControls()) {
            return;
        }
        const sent = await this.createAndSendControl('terminal:resize', {
            kind: 'resize',
            cols: desiredSize.cols,
            rows: desiredSize.rows,
        });
        if (sent && this.desiredSize === desiredSize) {
            this.desiredSizeDirty = false;
        }
    }

    private async resendPendingControls(expectedSeq?: number): Promise<void> {
        if (!this.canSendControls()) {
            return;
        }
        if (expectedSeq !== undefined && !this.pendingControls.has(expectedSeq)) {
            await this.recoverMissingControl();
            return;
        }
        const pending = Array.from(this.pendingControls.values())
            .filter((control) => expectedSeq === undefined || control.seq >= expectedSeq)
            .sort((a, b) => a.seq - b.seq);
        for (const control of pending) {
            this.emitPendingControl(control);
        }
    }

    private async recoverMissingControl(): Promise<void> {
        this.rotateControlStream();
        this.handlers.onControlReset?.();
        await this.sendDesiredResizeIfNeeded();
    }

    private emitPendingControl(control: PendingTerminalControl): void {
        apiSocket.send(control.event, {
            terminalId: this.terminalId,
            payload: control.payload,
        });
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

        this.rotateControlStream();
        if (this.lastNotifiedEpoch !== epoch) {
            this.lastNotifiedEpoch = epoch;
            this.handlers.onEpochReset?.();
        }
        return true;
    }

    private applyWriterState(state: TerminalWriterState): void {
        const writerSocketId = typeof state.writerSocketId === 'string'
            ? state.writerSocketId
            : null;
        const generation = Number.isSafeInteger(state.generation) && state.generation >= 0
            ? state.generation
            : 0;
        const writerChanged = this.writerStateInitialized
            && writerSocketId !== this.currentWriterSocketId;
        const ownershipChanged = this.writerStateInitialized
            && this.writer !== (state.isWriter === true);
        const becameWriter = this.writerStateInitialized
            && !this.writer
            && state.isWriter === true;

        this.currentWriterSocketId = writerSocketId;
        this.writerGeneration = generation;
        this.writer = state.isWriter === true;
        this.writerStateInitialized = true;

        if (writerChanged || ownershipChanged) {
            this.rotateControlStream();
        }
        this.handlers.onWriter({
            writerSocketId: this.currentWriterSocketId,
            generation: this.writerGeneration,
            isWriter: this.writer,
        });
        if (becameWriter && this.controlReady) {
            void this.enqueueOutbound(() => this.sendDesiredResizeIfNeeded());
        }
    }

    private rotateControlStream(): void {
        this.pendingControls.clear();
        this.controlSeq = 0;
        this.controlStreamId = Crypto.randomUUID();
        this.desiredSizeDirty = this.desiredSize !== null;
    }

    private enqueueInbound(operation: (generation: number) => Promise<void>): void {
        const lifecycleGeneration = this.lifecycleGeneration;
        const next = this.inboundQueue.then(async () => {
            if (this.isLifecycleCurrent(lifecycleGeneration)) {
                await operation(lifecycleGeneration);
            }
        });
        this.inboundQueue = next.catch((error) => {
            if (this.isLifecycleCurrent(lifecycleGeneration)) {
                const message = error instanceof Error ? error.message : String(error);
                this.handlers.onError(message);
            }
        });
    }

    private enqueueOutbound(
        operation: () => Promise<void>,
        lifecycleGeneration = this.lifecycleGeneration,
    ): Promise<void> {
        const next = this.outboundQueue.then(async () => {
            if (this.isLifecycleCurrent(lifecycleGeneration)) {
                await operation();
            }
        });
        this.outboundQueue = next.catch((error) => {
            if (this.isLifecycleCurrent(lifecycleGeneration)) {
                const message = error instanceof Error ? error.message : String(error);
                this.handlers.onError(message);
            }
        });
        return this.outboundQueue;
    }

    private isLifecycleCurrent(generation: number): boolean {
        return !this.detached && generation === this.lifecycleGeneration;
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

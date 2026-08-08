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
import type { MachineEncryption } from './encryption/machineEncryption';
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
 * One live terminal connection: attach → snapshot/replay → subscribe →
 * take the writer seat → stream. Reconnects resync from the daemon's
 * authoritative snapshot and re-sends unacknowledged input in order.
 */
export class TerminalStream {
    private lastOutputSeq = 0;
    private inputSeq = 0;
    private readonly unackedInputs = new Map<number, string>();
    private readonly disposers: Array<() => void> = [];
    private wired = false;
    private status: TerminalStreamStatus = 'connecting';

    constructor(
        private readonly machineId: string,
        private readonly terminalId: string,
        private readonly handlers: TerminalStreamHandlers,
    ) {}

    async attach(): Promise<TerminalAttachResult> {
        this.setStatus('connecting');
        if (!this.wired) {
            this.wireSocketEvents();
            this.wired = true;
        }

        const result = await terminalAttach(this.machineId, this.terminalId, this.lastOutputSeq);
        this.handlers.onAttach(result);

        if (result.status === 'running') {
            this.lastOutputSeq = result.nextSeq - 1;
            this.subscribeAndTakeControl();
            this.setStatus('attached');
        } else if (result.status === 'exited') {
            this.setStatus('exited');
            this.handlers.onExit(result.exitCode ?? 0);
        }
        return result;
    }

    async sendInput(data: string): Promise<void> {
        const seq = ++this.inputSeq;
        this.unackedInputs.set(seq, data);
        const payload = await this.encrypt<TerminalInputFrame>({ seq, kind: 'input', data });
        apiSocket.send('terminal:input', { terminalId: this.terminalId, payload });
    }

    async sendResize(cols: number, rows: number): Promise<void> {
        const seq = ++this.inputSeq;
        const payload = await this.encrypt<TerminalInputFrame>({ seq, kind: 'resize', cols, rows });
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

    private subscribeAndTakeControl(): void {
        apiSocket.send('terminal:subscribe', { terminalId: this.terminalId });
        apiSocket.send('terminal:takeover', { terminalId: this.terminalId });
    }

    private async handleOutputFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!frame || frame.kind !== 'output' || frame.seq <= this.lastOutputSeq) {
            return;
        }
        this.lastOutputSeq = frame.seq;
        if (frame.data) {
            this.handlers.onOutput(frame.data);
        }
    }

    private async handleExitFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!frame || frame.kind !== 'exit') {
            return;
        }
        this.setStatus('exited');
        this.handlers.onExit(frame.exitCode ?? 0);
    }

    private async handleInputAckFrame(payload: string): Promise<void> {
        const frame = await this.decrypt<TerminalOutputFrame>(payload);
        if (!frame || frame.kind !== 'input-ack') {
            return;
        }
        this.unackedInputs.delete(frame.seq);
    }

    private async resync(): Promise<void> {
        this.setStatus('reconnecting');
        try {
            const result = await terminalAttach(
                this.machineId,
                this.terminalId,
                this.lastOutputSeq,
            );
            if (result.status === 'running') {
                this.lastOutputSeq = result.nextSeq - 1;
                this.handlers.onAttach(result);
                this.subscribeAndTakeControl();

                const pending = Array.from(this.unackedInputs.entries())
                    .sort(([a], [b]) => a - b);
                for (const [seq, data] of pending) {
                    const payload = await this.encrypt<TerminalInputFrame>({
                        seq,
                        kind: 'input',
                        data,
                    });
                    apiSocket.send('terminal:input', { terminalId: this.terminalId, payload });
                }
                this.setStatus('attached');
            } else if (result.status === 'exited') {
                this.setStatus('exited');
                this.handlers.onExit(result.exitCode ?? 0);
            } else {
                this.setStatus('connecting');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus('error');
            this.handlers.onError(message);
        }
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

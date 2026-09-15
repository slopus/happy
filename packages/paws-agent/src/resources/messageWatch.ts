import { PawsAgentError } from '../client/errors';
import type { MessagePage, MessageSubscription, MessageWatchOptions } from '../client/types';

export const MAX_MESSAGE_SEQUENCE = 2_147_483_647;
export const validSequence = (seq: unknown, minimum = 1): seq is number =>
    typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= minimum && seq <= MAX_MESSAGE_SEQUENCE;

/** A cursor belongs to one subscriber. Only successfully delivered durable rows advance it. */
export class MessageWatch implements MessageSubscription {
    private cursor: number;
    private watermark: number;
    private running: Promise<void> | null = null;
    private requested = false;
    private active = true;
    private failure: PawsAgentError | null = null;
    private readonly controller = new AbortController();
    private readonly abort = () => this.unsubscribe();

    constructor(
        private readonly options: MessageWatchOptions,
        private readonly read: (afterSeq: number, signal: AbortSignal) => Promise<MessagePage>,
        private readonly remove: () => void,
        private readonly report: (error: PawsAgentError) => void,
    ) {
        this.cursor = this.watermark = options.afterSeq;
        options.signal?.addEventListener('abort', this.abort, { once: true });
        if (options.signal?.aborted) this.unsubscribe();
    }

    unsubscribe(): void {
        if (!this.active) return;
        this.active = false;
        this.options.signal?.removeEventListener('abort', this.abort);
        this.controller.abort();
        this.remove();
    }

    notify(seq: unknown): void {
        if (!this.active || this.failure) return;
        if (!validSequence(seq)) {
            this.fail(new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Message notification has an invalid sequence'));
            return;
        }
        if (seq <= this.cursor) return;
        this.watermark = Math.max(this.watermark, seq);
        void this.sync().catch(() => {}); // sync reports errors to the watch and client.
    }

    sync(): Promise<void> {
        if (!this.active) return Promise.reject(new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled'));
        if (this.failure) return Promise.reject(this.failure);
        this.requested = true;
        if (this.running) return this.running;
        let succeeded = false;
        this.running = this.drain().then(() => { succeeded = true; }).catch(cause => {
            const error = cause instanceof PawsAgentError ? cause : new PawsAgentError('UNKNOWN', 'Message synchronization failed', { cause });
            if (this.active && !this.failure) this.fail(error);
            throw error;
        }).finally(() => {
            this.running = null;
            // A notification may land after drain resolves, before this microtask.
            // Chain its work so callers awaiting catch-up also await that notification.
            if (succeeded && this.requested && this.active && !this.failure) return this.sync();
            return undefined;
        });
        return this.running;
    }

    private fail(error: PawsAgentError): void {
        if (error.code === 'PROTOCOL_UNSUPPORTED' || error.code === 'DECRYPTION_FAILED') this.failure = error;
        this.report(error);
        try { this.options.onError?.(error); } catch { /* Error listeners cannot break the synchronization lifecycle. */ }
    }

    private async drain(): Promise<void> {
        while (this.requested) {
            this.requested = false;
            let hasMore = true;
            while (hasMore) {
                const start = this.cursor;
                const watermarkAtRead = this.watermark;
                const page = await this.readPage(start);
                if (!this.active) throw new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled');
                if (this.failure) throw this.failure;
                // Validate the entire page before delivering anything from it.
                let expected = start + 1;
                const fresh = page.messages.filter(message => message.seq > start);
                const unique = fresh.filter((message, index) => index === 0 || message.seq !== fresh[index - 1].seq);
                for (const message of unique) {
                    if (message.seq !== expected++) throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Durable message sequence has a gap');
                }
                for (const message of unique) {
                    if (!this.active) throw new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled');
                    try { this.options.onMessage(message); }
                    catch (cause) {
                        this.failure = new PawsAgentError('UNKNOWN', 'Message listener failed; create a new watch from the last processed cursor', { cause });
                        this.report(this.failure);
                        try { this.options.onError?.(this.failure); } catch { /* Listener isolation. */ }
                        throw this.failure;
                    }
                    this.cursor = message.seq;
                }
                hasMore = page.hasMore || this.watermark > this.cursor;
                if (hasMore && this.cursor === start && this.watermark <= watermarkAtRead) {
                    throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Message pagination made no progress');
                }
            }
        }
    }

    private async readPage(afterSeq: number): Promise<MessagePage> {
        for (let attempt = 0; ; attempt++) {
            try { return await this.readOnce(afterSeq); }
            catch (error) {
                if (this.controller.signal.aborted || attempt >= 2 || !(error instanceof PawsAgentError)
                    || !['UNKNOWN', 'CONNECTION_LOST', 'RPC_TIMEOUT'].includes(error.code)) throw error;
                await new Promise<void>((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled')); };
                    const timer = setTimeout(() => { this.controller.signal.removeEventListener('abort', abort); resolve(); }, 50 * 2 ** attempt);
                    this.controller.signal.addEventListener('abort', abort, { once: true });
                });
            }
        }
    }

    private readOnce(afterSeq: number): Promise<MessagePage> {
        const signal = this.controller.signal;
        return new Promise((resolve, reject) => {
            const abort = () => reject(new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled'));
            if (signal.aborted) { abort(); return; }
            signal.addEventListener('abort', abort, { once: true });
            this.read(afterSeq, signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }
}

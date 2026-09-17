import { configurationMeta } from './configuration';
import { PawsAgentError } from '../client/errors';
import type { Message, MessageHistoryOptions, MessagePage, MessageSubscription, MessageWatchOptions, MessagesResource, SendMessageInput, SendMessageReceipt } from '../client/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../crypto/encryption';
import { RecordEncryptionStore } from '../crypto/records';
import type { PawsHttpTransport } from '../transport/http';
import type { SessionsResourceImpl } from './sessions';
import { encryptImage, snapshotImages } from './imageAttachments';
import { MessageWatch, MAX_MESSAGE_SEQUENCE, validSequence } from './messageWatch';

type RawMessage = {
    id: string;
    seq: number;
    content: { t: string; c?: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

export class MessagesResourceImpl implements MessagesResource {
    private readonly watches = new Map<MessageWatch, string>();
    private disposed = false;
    constructor(
        private readonly transport: PawsHttpTransport,
        private readonly sessions: SessionsResourceImpl,
        private readonly encryption: RecordEncryptionStore,
        private readonly report: (error: PawsAgentError) => void = () => {},
    ) {}

    async history(sessionId: string, options: MessageHistoryOptions = {}): Promise<Message[]> {
        const page = await this.historyPage(sessionId, options);
        return options.afterSeq === undefined && options.beforeSeq === undefined
            ? page.messages.sort((a, b) => a.createdAt - b.createdAt)
            : page.messages;
    }

    async historyPage(sessionId: string, options: MessageHistoryOptions = {}): Promise<MessagePage> {
        this.requireActive(sessionId);
        const limit = options.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'limit must be between 1 and 500');
        }
        if ((options.afterSeq !== undefined && !validSequence(options.afterSeq, 0))
            || (options.beforeSeq !== undefined && !validSequence(options.beforeSeq))
            || (options.afterSeq !== undefined && options.beforeSeq !== undefined)) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'Provide one valid exclusive sequence cursor');
        }
        const recordEncryption = await this.getEncryption(sessionId);
        const cursor = options.afterSeq !== undefined ? `after_seq=${options.afterSeq}` : `before_seq=${options.beforeSeq ?? MAX_MESSAGE_SEQUENCE}`;
        const response = await this.transport.get<{ messages: RawMessage[]; hasMore?: boolean }>(
            `/v3/sessions/${encodeURIComponent(sessionId)}/messages?${cursor}&limit=${limit}`, { signal: options.signal },
        );
        if (!response || !Array.isArray(response.messages) || (response.hasMore !== undefined && typeof response.hasMore !== 'boolean')) {
            throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Malformed message page');
        }
        const messages = response.messages.map(raw => {
            if (!raw || !validSequence(raw.seq) || typeof raw.id !== 'string' || !raw.id
                || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)
                || raw.content?.t !== 'encrypted' || typeof raw.content.c !== 'string') {
                throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Unsupported message content');
            }
            let content: unknown;
            try { content = decrypt(recordEncryption.key, recordEncryption.variant, decodeBase64(raw.content.c)); }
            catch { throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt message'); }
            if (content === null) throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt message');
            return {
                id: raw.id,
                seq: raw.seq,
                content,
                localId: raw.localId,
                createdAt: raw.createdAt,
                updatedAt: raw.updatedAt,
            } satisfies Message;
        }).sort((a, b) => a.seq - b.seq);
        return { messages, hasMore: response.hasMore ?? messages.length >= limit };
    }

    async watch(sessionId: string, options: MessageWatchOptions): Promise<MessageSubscription> {
        this.requireActive(sessionId);
        if (!validSequence(options.afterSeq, 0) || typeof options.onMessage !== 'function') {
            throw new PawsAgentError('INVALID_ARGUMENT', 'watch requires afterSeq and onMessage');
        }
        if (options.signal?.aborted) throw new PawsAgentError('CONNECTION_LOST', 'Message watch cancelled');
        const watch = new MessageWatch(options,
            (afterSeq, signal) => this.historyPage(sessionId, { afterSeq, limit: 500, signal }),
            () => this.watches.delete(watch), this.report);
        this.watches.set(watch, sessionId);
        try { await watch.sync(); return watch; }
        catch (error) { watch.unsubscribe(); throw error; }
    }

    notify(sessionId: string, seq: unknown): void {
        for (const [watch, id] of this.watches) if (id === sessionId) watch.notify(seq);
    }

    async syncWatches(): Promise<void> {
        // allSettled keeps every watch's failure observed before readiness can be published.
        const watches = [...this.watches.keys()];
        const results = await Promise.allSettled(watches.map(watch => watch.sync()));
        const failure = results.find((result, index) => result.status === 'rejected' && this.watches.has(watches[index]));
        if (failure?.status === 'rejected') throw failure.reason;
    }

    dispose(): void {
        this.disposed = true;
        for (const watch of this.watches.keys()) watch.unsubscribe();
    }

    private requireActive(sessionId: string): void {
        if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'Client has been disposed');
        if (typeof sessionId !== 'string' || !sessionId.trim()) throw new PawsAgentError('INVALID_ARGUMENT', 'sessionId is required');
    }

    async send(input: SendMessageInput): Promise<SendMessageReceipt> {
        if (!input.sessionId.trim()) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'sessionId is required');
        }
        const configuration = configurationMeta(input.configuration);
        const images = snapshotImages(input.images);
        const checkCancelled = () => {
            if (input.signal?.aborted) throw new PawsAgentError('CONNECTION_LOST', 'Message send cancelled');
        };
        checkCancelled();
        const session = await this.sessions.get(input.sessionId);
        checkCancelled();
        const metadata = session.metadata as { lifecycleState?: unknown } | null;
        if (!session.active || metadata?.lifecycleState === 'archived') {
            throw new PawsAgentError('SESSION_ARCHIVED', 'Session is archived', {
                details: { sessionId: input.sessionId },
            });
        }
        const recordEncryption = await this.getEncryption(input.sessionId);
        const localId = input.localId ?? globalThis.crypto.randomUUID();
        const batch: { localId: string; content: string }[] = [];
        try {
        for (const [index, image] of images.entries()) {
            checkCancelled();
            const bytes = encryptImage(image.bytes, recordEncryption);
            const descriptor = await this.transport.post<unknown>(
                `/v1/sessions/${encodeURIComponent(input.sessionId)}/attachments/request-upload`,
                { filename: image.name, size: bytes.length }, { signal: input.signal },
            );
            const ref = await this.transport.uploadAttachment(descriptor, bytes, { signal: input.signal });
            checkCancelled();
            const fileLocalId = `${localId}:image:${index}`;
            const file = {
                role: 'session',
                content: { type: 'session', data: {
                    id: fileLocalId, time: Date.now(), role: 'user',
                    ev: { t: 'file', ref, name: image.name, size: image.bytes.length, mimeType: image.mimeType,
                        ...(image.width !== undefined ? { image: { width: image.width, height: image.height } } : {}),
                    },
                } },
            };
            batch.push({ localId: fileLocalId, content: encodeBase64(encrypt(recordEncryption.key, recordEncryption.variant, file)) });
        }
        } catch (cause) {
            throw new PawsAgentError(cause instanceof PawsAgentError ? cause.code : 'UNKNOWN', 'Image attachment preparation failed; no message was submitted', { cause, details: { phase: 'attachments', messageSubmitted: false } });
        }
        const content = {
            role: 'user',
            content: { type: 'text', text: input.text },
            meta: { sentFrom: 'paws-agent', ...input.meta, ...configuration },
        };
        // CLI 在收到 user/text 时领取之前的附件；仅图片也必须保留空正文。
        batch.push({ localId, content: encodeBase64(encrypt(recordEncryption.key, recordEncryption.variant, content)) });
        checkCancelled();
        await this.transport.post(
            `/v3/sessions/${encodeURIComponent(input.sessionId)}/messages`,
            {
                messages: batch,
            },
            { signal: input.signal },
        );
        return { sessionId: input.sessionId, localId };
    }

    private async getEncryption(sessionId: string) {
        let encryption = this.encryption.getSession(sessionId);
        if (!encryption) {
            await this.sessions.get(sessionId);
            encryption = this.encryption.getSession(sessionId);
        }
        if (!encryption) {
            throw new PawsAgentError('DECRYPTION_FAILED', 'Session encryption is unavailable');
        }
        return encryption;
    }
}

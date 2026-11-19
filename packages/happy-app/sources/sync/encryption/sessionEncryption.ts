import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { RawRecord } from '../typesRaw';
import { ApiMessage } from '../apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema, AgentState, AgentStateSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';

async function yieldToUI(): Promise<void> {
    const scheduler = (globalThis as typeof globalThis & {
        scheduler?: { yield?: () => Promise<void> };
    }).scheduler;
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
}

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    createDetached(): SessionEncryption {
        return new SessionEncryption(this.sessionId, this.encryptor, new EncryptionCache());
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: ApiMessage[]): Promise<(DecryptedMessage | null)[]> {
        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: ApiMessage }[] = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message) {
                results[i] = null;
                continue;
            }

            // Check cache first
            const cached = this.cache.getCachedMessage(message.id);
            if (cached) {
                results[i] = cached;
            } else if (message.content.t === 'encrypted') {
                toDecrypt.push({ index: i, message });
            } else {
                // Not encrypted or invalid
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: null,
                    createdAt: message.createdAt,
                };
                this.cache.setCachedMessage(message.id, results[i]!);
            }
        }

        // Native crypto wrappers can resolve synchronously too. An async
        // function or Promise.all doesn't let input run between microtasks.
        // Bound decoding/decryption on every platform and yield a real task.
        const batchSize = 16;
        const decryptedForCache: DecryptedMessage[] = [];
        let lastYieldAt = Date.now();
        for (let offset = 0; offset < toDecrypt.length; offset += batchSize) {
            // Give pending input a turn after the first batch. Thereafter use
            // a time budget so cheap rows do not pay a clamped timer per batch
            // on browsers without scheduler.yield.
            if (offset > 0
                && (offset === batchSize || Date.now() - lastYieldAt >= 8)) {
                await yieldToUI();
                lastYieldAt = Date.now();
            }
            const batch = toDecrypt.slice(offset, offset + batchSize);
            const encrypted = batch.map(item =>
                decodeBase64(item.message.content.c, 'base64')
            );
            
            const decrypted = await this.encryptor.decrypt(encrypted);

            for (let i = 0; i < batch.length; i++) {
                const decryptedData = decrypted[i];
                const { message, index } = batch[i];

                if (decryptedData) {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: decryptedData,
                        createdAt: message.createdAt,
                    };
                    decryptedForCache.push(result);
                    results[index] = result;
                } else {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: null,
                        createdAt: message.createdAt,
                    };
                    decryptedForCache.push(result);
                    results[index] = result;
                }
            }
        }

        // Preserve rejection semantics: malformed ciphertext or a rejecting
        // decryptor must not leave earlier encrypted batches in the cache.
        // Cache insertion/eviction is also bounded so a large window does not
        // replace the crypto stall with one long cache-maintenance task.
        lastYieldAt = Date.now();
        for (let offset = 0; offset < decryptedForCache.length; offset += batchSize) {
            if (offset > 0 && Date.now() - lastYieldAt >= 8) {
                await yieldToUI();
                lastYieldAt = Date.now();
            }
            for (const result of decryptedForCache.slice(offset, offset + batchSize)) {
                this.cache.setCachedMessage(result.id, result);
            }
        }

        return results;
    }

    /**
     * Single message convenience method
     */
    async decryptMessage(message: ApiMessage | null | undefined): Promise<DecryptedMessage | null> {
        if (!message) {
            return null;
        }
        const results = await this.decryptMessages([message]);
        return results[0];
    }

    /**
     * Encrypt a raw record
     */
    async encryptRawRecord(record: RawRecord): Promise<string> {
        const encrypted = await this.encryptor.encrypt([record]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Encrypt raw data using session-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt raw data using session-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Encrypt metadata using session-specific encryption
     */
    async encryptMetadata(metadata: Metadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([metadata]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt metadata using session-specific encryption
     */
    async decryptMetadata(version: number, encrypted: string): Promise<Metadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMetadata(this.sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encrypted, 'base64');
        const decrypted = await this.encryptor.decrypt([encryptedData]);
        if (!decrypted[0]) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return null;
        }

        // Cache the result
        this.cache.setCachedMetadata(this.sessionId, version, parsed.data);
        return parsed.data;
    }

    /**
     * Encrypt agent state using session-specific encryption
     */
    async encryptAgentState(state: AgentState): Promise<string> {
        const encrypted = await this.encryptor.encrypt([state]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt agent state using session-specific encryption
     */
    async decryptAgentState(version: number, encrypted: string | null | undefined): Promise<AgentState> {
        if (!encrypted) {
            return {};
        }

        // Check cache first
        const cached = this.cache.getCachedAgentState(this.sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encrypted, 'base64');
        const decrypted = await this.encryptor.decrypt([encryptedData]);
        if (!decrypted[0]) {
            return {};
        }
        const parsed = AgentStateSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return {};
        }

        // Cache the result
        this.cache.setCachedAgentState(this.sessionId, version, parsed.data);
        return parsed.data;
    }
}

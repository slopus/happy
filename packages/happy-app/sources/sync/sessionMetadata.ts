import { apiSocket } from './apiSocket';
import type { SessionEncryption } from './encryption/sessionEncryption';
import type { Metadata } from './storageTypes';

type SessionMetadataUpdateResponse = {
    result: 'success' | 'version-mismatch' | 'error';
    version?: number;
    metadata?: string;
    message?: string;
};

/**
 * Update encrypted session metadata with optimistic concurrency.
 *
 * The updater is re-applied to the latest decrypted metadata after every
 * version conflict. Returning the exact current object is an intentional
 * no-op, which lets conditional writers protect newer manual changes without
 * consuming another metadata version.
 */
export async function updateEncryptedSessionMetadata(
    sessionId: string,
    metadata: Metadata,
    expectedVersion: number,
    sessionEncryption: SessionEncryption,
    update: (metadata: Metadata) => Metadata,
    maxRetries: number = 3,
): Promise<{ version: number; metadata: Metadata }> {
    let currentVersion = expectedVersion;
    let currentMetadata = metadata;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const nextMetadata = update(currentMetadata);
        if (nextMetadata === currentMetadata) {
            return { version: currentVersion, metadata: currentMetadata };
        }

        const encryptedMetadata = await sessionEncryption.encryptRaw(nextMetadata);
        const result = await apiSocket.emitWithAck<SessionMetadataUpdateResponse>('update-metadata', {
            sid: sessionId,
            expectedVersion: currentVersion,
            metadata: encryptedMetadata,
        });

        if (result.result === 'success') {
            if (typeof result.version !== 'number' || typeof result.metadata !== 'string') {
                throw new Error('Session metadata update returned an invalid response');
            }
            const decrypted = await sessionEncryption.decryptRaw(result.metadata) as Metadata | null;
            if (!decrypted) {
                throw new Error('Session metadata update returned invalid encrypted metadata');
            }
            return { version: result.version, metadata: decrypted };
        }

        if (result.result === 'version-mismatch') {
            if (typeof result.version !== 'number' || typeof result.metadata !== 'string') {
                throw new Error('Session metadata version mismatch');
            }
            const latest = await sessionEncryption.decryptRaw(result.metadata) as Metadata | null;
            if (!latest) {
                throw new Error('Session metadata version mismatch returned invalid encrypted metadata');
            }
            currentVersion = result.version;
            currentMetadata = latest;
            continue;
        }

        throw new Error(result.message || 'Failed to update session metadata');
    }

    throw new Error(`Failed to update session metadata after ${maxRetries} retries due to version conflicts`);
}

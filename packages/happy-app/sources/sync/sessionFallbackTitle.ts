import type { SessionEncryption } from './encryption/sessionEncryption';
import { updateEncryptedSessionMetadata } from './sessionMetadata';
import type { Metadata } from './storageTypes';
import { deriveSessionFallbackTitle } from '@/utils/sessionFallbackTitleText';

export { deriveSessionFallbackTitle, SESSION_FALLBACK_TITLE_MAX_LENGTH } from '@/utils/sessionFallbackTitleText';

export async function ensureSessionFallbackTitle(args: {
    sessionId: string;
    metadata: Metadata;
    metadataVersion: number;
    sessionEncryption: SessionEncryption;
    title: string;
    now?: () => number;
}): Promise<{ version: number; metadata: Metadata }> {
    const now = args.now ?? Date.now;
    return updateEncryptedSessionMetadata(
        args.sessionId,
        args.metadata,
        args.metadataVersion,
        args.sessionEncryption,
        metadata => {
            if (metadata.summary?.text.trim()) {
                return metadata;
            }
            return {
                ...metadata,
                summary: {
                    text: args.title,
                    updatedAt: now(),
                },
            };
        },
    );
}

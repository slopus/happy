import type { AttachmentPreview } from './attachmentTypes';
import type { SessionEncryption } from './encryption/sessionEncryption';
import { updateEncryptedSessionMetadata } from './sessionMetadata';
import type { Metadata } from './storageTypes';

export const SESSION_FALLBACK_TITLE_MAX_LENGTH = 80;

export function deriveSessionFallbackTitle(
    text: string,
    attachments?: Pick<AttachmentPreview, 'name'>[],
): string | null {
    const source = text.trim() || attachments?.[0]?.name.trim() || '';
    const normalized = source
        .replace(/\s+/g, ' ')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
        .trim();
    if (!normalized) {
        return null;
    }
    return Array.from(normalized).slice(0, SESSION_FALLBACK_TITLE_MAX_LENGTH).join('').trim() || null;
}

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

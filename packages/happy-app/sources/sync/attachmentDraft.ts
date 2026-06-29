import type { AttachmentPreview } from '@/sync/attachmentTypes';

/**
 * Defensive parse for persisted new-session attachments. MMKV holds arbitrary
 * prior-version JSON, so we drop anything that isn't a well-formed
 * AttachmentPreview rather than trusting the blob. Returns a fresh array
 * (never the input reference). Pure — no React Native deps — so it stays
 * unit-testable in a plain Node test environment.
 */
export function parsePersistedAttachments(raw: unknown): AttachmentPreview[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: AttachmentPreview[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const a = item as Record<string, unknown>;
        if (
            typeof a.id === 'string'
            && typeof a.uri === 'string'
            && typeof a.width === 'number'
            && typeof a.height === 'number'
            && typeof a.mimeType === 'string'
            && typeof a.size === 'number'
            && typeof a.name === 'string'
        ) {
            result.push({
                id: a.id,
                uri: a.uri,
                width: a.width,
                height: a.height,
                mimeType: a.mimeType,
                size: a.size,
                name: a.name,
                ...(typeof a.thumbhash === 'string' ? { thumbhash: a.thumbhash } : {}),
            });
        }
    }
    return result;
}

/**
 * Loads, decrypts and exposes a chat attachment as a data URI for inline
 * rendering in chat bubbles. Decrypted blobs are kept in a module-level LRU
 * (max 50 entries) so scrolling back through the chat does not re-decrypt
 * every image. In-flight requests are de-duplicated per ref.
 */
import * as React from 'react';
import { sync } from '@/sync/sync';
import { downloadEncryptedAttachment } from '@/sync/apiAttachments';
import { decryptBlob } from '@/encryption/blob';
import { encodeBase64 } from '@/encryption/base64';
import type { AttachmentImageOptions, AttachmentImageState } from './attachmentImageTypes';
import { detectHonorMotionPhoto } from '@slopus/happy-wire';

export type { AttachmentImageState } from './attachmentImageTypes';

export function releaseImageViewerImageCache() {
    // Native keeps the existing data-URI cache; the viewer-specific Blob cache is Web-only.
}

const MAX_CACHE_ENTRIES = 50;
type CachedImage = { uri: string; motionPhoto?: NonNullable<AttachmentImageState['motionPhoto']> };
const cache = new Map<string, CachedImage>();
const inFlight = new Map<string, Promise<CachedImage | null>>();

function rememberInCache(ref: string, image: CachedImage) {
    if (cache.has(ref)) cache.delete(ref);
    cache.set(ref, image);
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function detectImageMime(bytes: Uint8Array): string {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return 'image/png';
}

async function loadAttachmentDataUri(sessionId: string, ref: string): Promise<CachedImage | null> {
    const credentials = sync.getCredentials();
    if (!credentials) {
        console.warn(`[attachment-image] no credentials for ${ref}`);
        return null;
    }
    const blobKey = sync.encryption.getSessionBlobKey(sessionId);
    if (!blobKey) {
        console.warn(`[attachment-image] no blobKey for session ${sessionId} (ref=${ref})`);
        return null;
    }
    if (blobKey.length !== 32) {
        console.warn(`[attachment-image] blobKey wrong length: ${blobKey.length} (ref=${ref})`);
        return null;
    }
    let encrypted: Uint8Array;
    try {
        encrypted = await downloadEncryptedAttachment(credentials, sessionId, ref);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[attachment-image] download failed for ${ref}: ${message}`);
        return null;
    }
    const decrypted = decryptBlob(encrypted, blobKey);
    if (!decrypted) {
        console.warn(`[attachment-image] decrypt returned null for ${ref} (encrypted.length=${encrypted.length})`);
        return null;
    }
    const mime = detectImageMime(decrypted);
    const motionPhoto = detectHonorMotionPhoto(decrypted);
    return {
        uri: `data:${mime};base64,${encodeBase64(decrypted)}`,
        ...(motionPhoto ? { motionPhoto } : {}),
    };
}

type KeyedAttachmentImageState = AttachmentImageState & {
    cacheKey: string | null;
};

export function useAttachmentImage(
    sessionId: string,
    ref: string | undefined,
    _options?: AttachmentImageOptions,
): AttachmentImageState {
    const cacheKey = ref ? `${sessionId}:${ref}` : null;
    const [state, setState] = React.useState<KeyedAttachmentImageState>(() => {
        if (!cacheKey) return { cacheKey: null, uri: null, loading: false, error: null };
        const cached = cache.get(cacheKey);
        return cached
            ? { cacheKey, uri: cached.uri, loading: false, error: null, motionPhoto: cached.motionPhoto }
            : { cacheKey, uri: null, loading: true, error: null };
    });

    React.useEffect(() => {
        if (!ref || !cacheKey) {
            setState({ cacheKey: null, uri: null, loading: false, error: null });
            return;
        }
        const cached = cache.get(cacheKey);
        if (cached) {
            cache.delete(cacheKey);
            cache.set(cacheKey, cached);
            setState({ cacheKey, uri: cached.uri, loading: false, error: null, motionPhoto: cached.motionPhoto });
            return;
        }
        let cancelled = false;
        setState({ cacheKey, uri: null, loading: true, error: null });

        let promise = inFlight.get(cacheKey);
        if (!promise) {
            promise = loadAttachmentDataUri(sessionId, ref)
                .finally(() => { inFlight.delete(cacheKey); });
            inFlight.set(cacheKey, promise);
        }

        promise.then((image) => {
            if (cancelled) return;
            if (image) {
                rememberInCache(cacheKey, image);
                setState({ cacheKey, uri: image.uri, loading: false, error: null, motionPhoto: image.motionPhoto });
            } else {
                setState({ cacheKey, uri: null, loading: false, error: 'decrypt_failed' });
            }
        }).catch((err) => {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : 'unknown';
            setState({ cacheKey, uri: null, loading: false, error: message });
        });

        return () => { cancelled = true; };
    }, [cacheKey, ref, sessionId]);

    if (state.cacheKey !== cacheKey) {
        return { uri: null, loading: cacheKey !== null, error: null };
    }
    return state;
}

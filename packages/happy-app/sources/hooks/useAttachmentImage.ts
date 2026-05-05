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

const MAX_CACHE_ENTRIES = 50;
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function rememberInCache(ref: string, dataUri: string) {
    if (cache.has(ref)) cache.delete(ref);
    cache.set(ref, dataUri);
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

async function loadAttachmentDataUri(sessionId: string, ref: string): Promise<string | null> {
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
    console.log(`[attachment-image] downloaded ${encrypted.length} bytes for ${ref} (key.length=${blobKey.length}, key.buf=${blobKey.buffer.byteLength}, key.off=${blobKey.byteOffset})`);
    const decrypted = decryptBlob(encrypted, blobKey);
    if (!decrypted) {
        console.warn(`[attachment-image] decrypt returned null for ${ref} (encrypted.length=${encrypted.length})`);
        return null;
    }
    console.log(`[attachment-image] decrypted ${decrypted.length} bytes for ${ref}`);
    const mime = detectImageMime(decrypted);
    return `data:${mime};base64,${encodeBase64(decrypted)}`;
}

export type AttachmentImageState = {
    uri: string | null;
    loading: boolean;
    error: string | null;
};

export function useAttachmentImage(sessionId: string, ref: string | undefined): AttachmentImageState {
    const [state, setState] = React.useState<AttachmentImageState>(() => {
        if (!ref) return { uri: null, loading: false, error: null };
        const cached = cache.get(ref);
        return cached
            ? { uri: cached, loading: false, error: null }
            : { uri: null, loading: true, error: null };
    });

    React.useEffect(() => {
        if (!ref) {
            setState({ uri: null, loading: false, error: null });
            return;
        }
        const cached = cache.get(ref);
        if (cached) {
            cache.delete(ref);
            cache.set(ref, cached);
            setState({ uri: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;
        setState({ uri: null, loading: true, error: null });

        let promise = inFlight.get(ref);
        if (!promise) {
            promise = loadAttachmentDataUri(sessionId, ref)
                .finally(() => { inFlight.delete(ref); });
            inFlight.set(ref, promise);
        }

        promise.then((uri) => {
            if (cancelled) return;
            if (uri) {
                rememberInCache(ref, uri);
                setState({ uri, loading: false, error: null });
            } else {
                setState({ uri: null, loading: false, error: 'decrypt_failed' });
            }
        }).catch((err) => {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : 'unknown';
            setState({ uri: null, loading: false, error: message });
        });

        return () => { cancelled = true; };
    }, [sessionId, ref]);

    return state;
}

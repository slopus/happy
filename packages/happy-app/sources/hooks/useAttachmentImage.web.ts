/** Web attachment loader with bounded original-image retention and resized previews. */
import * as React from 'react';
import { sync } from '@/sync/sync';
import { downloadEncryptedAttachment } from '@/sync/apiAttachments';
import { decryptBlob } from '@/encryption/blob';
import { detectSupportedImageMime } from '@/utils/detectSupportedImageMime';
import { createAttachmentImageSource } from '@/utils/attachmentImageSource';
import type { LoadedAttachmentImageSource } from '@/utils/attachmentImageSourceTypes';
import type { AttachmentImageOptions, AttachmentImageState } from './attachmentImageTypes';
import { detectHonorMotionPhoto } from '@slopus/happy-wire';

export type { AttachmentImageState } from './attachmentImageTypes';

const MAX_THUMBNAIL_CACHE_ENTRIES = 80;
const MAX_FULL_IMAGE_CACHE_ENTRIES = 3;
type LoadedMotionImageSource = LoadedAttachmentImageSource & {
    motionPhoto?: NonNullable<AttachmentImageState['motionPhoto']>;
};
const thumbnailCache = new Map<string, LoadedMotionImageSource>();
const fullImageCache = new Map<string, LoadedMotionImageSource>();
const viewerImageCache = new Map<string, LoadedMotionImageSource>();
const inFlight = new Map<string, Promise<LoadedMotionImageSource | null>>();
let viewerCacheGeneration = 0;

export function releaseImageViewerImageCache() {
    viewerCacheGeneration += 1;
    for (const source of viewerImageCache.values()) source.dispose();
    viewerImageCache.clear();
    for (const key of inFlight.keys()) {
        if (key.endsWith(':viewer')) inFlight.delete(key);
    }
}

function createTaskScheduler(maxConcurrent: number) {
    let active = 0;
    const pending: Array<() => void> = [];
    const drain = () => {
        while (active < maxConcurrent && pending.length > 0) {
            pending.shift()?.();
        }
    };
    return function schedule<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            pending.push(() => {
                active += 1;
                task().then(resolve, reject).finally(() => {
                    active -= 1;
                    drain();
                });
            });
            drain();
        });
    };
}

// Thumbnail work is intentionally isolated so opening an original never waits
// behind a long conversation's preview-decode queue.
const scheduleThumbnail = createTaskScheduler(2);
const scheduleFullImage = createTaskScheduler(2);

function getCache(options: AttachmentImageOptions | undefined) {
    if (options?.lifetime === 'viewer') return viewerImageCache;
    return options?.maxDimension ? thumbnailCache : fullImageCache;
}

function getCacheLimit(options: AttachmentImageOptions | undefined): number {
    if (options?.lifetime === 'viewer') return MAX_FULL_IMAGE_CACHE_ENTRIES;
    return options?.maxDimension ? MAX_THUMBNAIL_CACHE_ENTRIES : MAX_FULL_IMAGE_CACHE_ENTRIES;
}

function rememberInCache(
    cache: Map<string, LoadedMotionImageSource>,
    key: string,
    source: LoadedMotionImageSource,
    limit: number,
) {
    const existing = cache.get(key);
    if (existing === source) return;
    if (existing) existing.dispose();
    cache.delete(key);
    cache.set(key, source);
    while (cache.size > limit) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        oldest?.dispose();
    }
}

async function loadAttachmentSource(
    sessionId: string,
    ref: string,
    options: AttachmentImageOptions | undefined,
): Promise<LoadedMotionImageSource | null> {
    const credentials = sync.getCredentials();
    if (!credentials) {
        console.warn(`[attachment-image] no credentials for ${ref}`);
        return null;
    }
    const blobKey = sync.encryption.getSessionBlobKey(sessionId);
    if (!blobKey || blobKey.length !== 32) {
        console.warn(`[attachment-image] invalid blobKey for session ${sessionId} (ref=${ref})`);
        return null;
    }
    let encrypted: Uint8Array;
    try {
        encrypted = await downloadEncryptedAttachment(credentials, sessionId, ref);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[attachment-image] download failed for ${ref}: ${message}`);
        return null;
    }
    const decrypted = decryptBlob(encrypted, blobKey);
    if (!decrypted) {
        console.warn(`[attachment-image] decrypt returned null for ${ref}`);
        return null;
    }
    const mime = detectSupportedImageMime(decrypted) ?? 'image/png';
    const source: LoadedMotionImageSource = await createAttachmentImageSource(decrypted, mime, options);
    const motionPhoto = detectHonorMotionPhoto(decrypted);
    if (motionPhoto) source.motionPhoto = motionPhoto;
    return source;
}

type KeyedAttachmentImageState = AttachmentImageState & { cacheKey: string | null };

export function useAttachmentImage(
    sessionId: string,
    ref: string | undefined,
    options?: AttachmentImageOptions,
): AttachmentImageState {
    const variant = options?.lifetime === 'viewer'
        ? 'viewer'
        : options?.maxDimension ? `thumbnail-${options.maxDimension}` : 'full';
    const cacheKey = ref ? `${sessionId}:${ref}:${variant}` : null;
    const cache = getCache(options);
    const sourceWidth = options?.sourceWidth;
    const sourceHeight = options?.sourceHeight;
    const maxDimension = options?.maxDimension;
    const lifetime = options?.lifetime;
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
            const requestOptions = { lifetime, maxDimension, sourceWidth, sourceHeight };
            const requestGeneration = viewerCacheGeneration;
            const schedule = maxDimension ? scheduleThumbnail : scheduleFullImage;
            promise = schedule(() => loadAttachmentSource(sessionId, ref, requestOptions))
                .then((source) => {
                    if (!source) return null;
                    if (lifetime === 'viewer' && requestGeneration !== viewerCacheGeneration) {
                        source.dispose();
                        return null;
                    }
                    rememberInCache(cache, cacheKey, source, getCacheLimit(requestOptions));
                    return source;
                })
                .finally(() => { inFlight.delete(cacheKey); });
            inFlight.set(cacheKey, promise);
        }

        promise.then((source) => {
            if (cancelled) return;
            setState(source
                ? { cacheKey, uri: source.uri, loading: false, error: null, motionPhoto: source.motionPhoto }
                : { cacheKey, uri: null, loading: false, error: 'decrypt_failed' });
        }).catch((error) => {
            if (cancelled) return;
            setState({
                cacheKey,
                uri: null,
                loading: false,
                error: error instanceof Error ? error.message : 'unknown',
            });
        });

        return () => { cancelled = true; };
    }, [cache, cacheKey, lifetime, maxDimension, ref, sessionId, sourceHeight, sourceWidth]);

    if (state.cacheKey !== cacheKey) {
        return { uri: null, loading: cacheKey !== null, error: null };
    }
    return state;
}

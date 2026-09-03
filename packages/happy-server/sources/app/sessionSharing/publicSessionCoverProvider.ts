import { z } from 'zod';

const PEXELS_API_ORIGIN = 'https://api.pexels.com';
const PEXELS_SEARCH_QUERY = 'nature';
const PEXELS_SEARCH_SIZE = 30;
const PEXELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const MAX_API_RESPONSE_SIZE = 1024 * 1024;
const MAX_IMAGE_RESPONSE_SIZE = 20 * 1024 * 1024;
export const MAX_IMPORTED_PUBLIC_SESSION_COVER_SIZE = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 60_000_000;
const MAX_INPUT_DIMENSION = 20_000;
const COVER_WIDTH = 2400;
const COVER_HEIGHT = 900;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_HOSTS = new Set(['images.pexels.com']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const pexelsPhotoSchema = z.object({
    id: z.number().int().positive(),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    url: z.string().url().max(1_000),
    photographer: z.string().min(1).max(200),
    photographer_url: z.string().url().max(1_000),
    photographer_id: z.number().int().positive(),
    avg_color: z.string().max(100).nullable(),
    src: z.object({
        original: z.string().url().max(2_000),
        large2x: z.string().url().max(2_000),
        large: z.string().url().max(2_000),
        medium: z.string().url().max(2_000),
        small: z.string().url().max(2_000),
        portrait: z.string().url().max(2_000),
        landscape: z.string().url().max(2_000),
        tiny: z.string().url().max(2_000),
    }).strict(),
    liked: z.boolean(),
    alt: z.string().max(2_000),
}).strict();

const pexelsSearchResponseSchema = z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    photos: z.array(pexelsPhotoSchema).max(100),
    total_results: z.number().int().nonnegative(),
    next_page: z.string().url().max(2_000).optional(),
    prev_page: z.string().url().max(2_000).optional(),
}).strict();

export interface PublicSessionCoverCandidate {
    provider: 'pexels';
    photoId: number;
    previewUrl: string;
    width: number;
    height: number;
    averageColor: string | null;
    attribution: {
        photographer: string;
        photographerUrl: string;
        photoUrl: string;
    };
}

export interface ImportedPublicSessionCover {
    bytes: Buffer;
    mimeType: 'image/webp';
    size: number;
    width: number;
    height: number;
    attribution: {
        photoId: number;
        photographer: string;
        photographerUrl: string;
        photoUrl: string;
    };
}

export interface ImportPexelsCoverDependencies {
    fetchImpl: typeof fetch;
    apiKey: string;
}

export class PexelsConfigurationError extends Error {
    override readonly name = 'PexelsConfigurationError';
}

export class PexelsProviderError extends Error {
    override readonly name = 'PexelsProviderError';
}

type CachedCandidates = {
    expiresAt: number;
    candidates: PublicSessionCoverCandidate[];
};

const candidateCache = new Map<string, CachedCandidates>();

function requireApiKey(apiKey: string): void {
    if (!apiKey.trim()) throw new PexelsConfigurationError('Pexels cover provider is not configured');
}

function assertAllowedImageUrl(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== 'https:'
        || !ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase())
        || Boolean(url.username || url.password)
        || Boolean(url.port && url.port !== '443')
    ) {
        throw new PexelsProviderError('Pexels returned an unsupported image host');
    }
    return url.toString();
}

function assertAllowedApiUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== PEXELS_API_ORIGIN) {
        throw new PexelsProviderError('Pexels returned an unsupported API host');
    }
    return url.toString();
}

function normalizePhoto(photo: z.infer<typeof pexelsPhotoSchema>): PublicSessionCoverCandidate {
    return {
        provider: 'pexels',
        photoId: photo.id,
        previewUrl: assertAllowedImageUrl(photo.src.landscape),
        width: photo.width,
        height: photo.height,
        averageColor: photo.avg_color,
        attribution: {
            photographer: photo.photographer,
            photographerUrl: photo.photographer_url,
            photoUrl: photo.url,
        },
    };
}

async function readBoundedBody(response: Response, maxBytes: number, controller: AbortController): Promise<Buffer> {
    const declaredSize = response.headers.get('content-length');
    if (declaredSize !== null) {
        const parsedSize = Number(declaredSize);
        if (Number.isFinite(parsedSize) && parsedSize > maxBytes) {
            controller.abort();
            throw new PexelsProviderError('Pexels response is too large');
        }
    }
    if (!response.body) {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > maxBytes) {
            controller.abort();
            throw new PexelsProviderError('Pexels response is too large');
        }
        return body;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > maxBytes) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new PexelsProviderError('Pexels response is too large');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalSize);
}

async function fetchBounded(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    expectedContentType: 'json' | 'image',
    maxBytes: number,
    validateUrl: (value: string) => string,
): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        let currentUrl = validateUrl(url);
        for (let redirectCount = 0; ; redirectCount += 1) {
            const requestInit = {
                ...init,
                redirect: 'manual',
                signal: controller.signal,
            } as Parameters<typeof fetch>[1];
            const response = await fetchImpl(currentUrl, requestInit);
            if (REDIRECT_STATUSES.has(response.status)) {
                await response.body?.cancel().catch(() => undefined);
                if (redirectCount >= MAX_REDIRECTS) {
                    controller.abort();
                    throw new PexelsProviderError('Pexels returned too many redirects');
                }
                const location = response.headers.get('location');
                if (!location) throw new PexelsProviderError('Pexels returned an invalid redirect location');
                let redirectedUrl: string;
                try {
                    redirectedUrl = new URL(location, currentUrl).toString();
                } catch {
                    throw new PexelsProviderError('Pexels returned an invalid redirect location');
                }
                currentUrl = validateUrl(redirectedUrl);
                continue;
            }
            if (!response.ok) throw new PexelsProviderError(`Pexels request failed with status ${response.status}`);
            const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
            if (expectedContentType === 'json' && contentType !== 'application/json') {
                throw new PexelsProviderError('Pexels returned an invalid API content type');
            }
            if (expectedContentType === 'image' && !/^image\/(?:jpeg|png|webp)$/.test(contentType)) {
                throw new PexelsProviderError('Pexels returned an invalid image content type');
            }
            return await readBoundedBody(response, maxBytes, controller);
        }
    } catch (error) {
        if (error instanceof PexelsProviderError) throw error;
        throw new PexelsProviderError('Pexels request failed');
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchPexelsJson(
    fetchImpl: typeof fetch,
    url: string,
    apiKey: string,
): Promise<unknown> {
    const body = await fetchBounded(fetchImpl, url, {
        headers: { Authorization: apiKey },
    }, 'json', MAX_API_RESPONSE_SIZE, assertAllowedApiUrl);
    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        throw new PexelsProviderError('Pexels returned invalid JSON');
    }
}

function cacheCandidates(query: string, candidates: PublicSessionCoverCandidate[]): void {
    if (candidateCache.size >= MAX_CACHE_ENTRIES && !candidateCache.has(query)) {
        const oldestKey = candidateCache.keys().next().value;
        if (oldestKey !== undefined) candidateCache.delete(oldestKey);
    }
    candidateCache.set(query, { expiresAt: Date.now() + PEXELS_CACHE_TTL_MS, candidates });
}

export async function getRandomPexelsCover(
    fetchImpl: typeof fetch,
    apiKey: string,
    random: () => number,
): Promise<PublicSessionCoverCandidate> {
    requireApiKey(apiKey);
    const cached = candidateCache.get(PEXELS_SEARCH_QUERY);
    let candidates = cached && cached.expiresAt > Date.now() ? cached.candidates : undefined;
    if (!candidates) {
        const url = new URL('/v1/search', PEXELS_API_ORIGIN);
        url.searchParams.set('query', PEXELS_SEARCH_QUERY);
        url.searchParams.set('orientation', 'landscape');
        url.searchParams.set('per_page', String(PEXELS_SEARCH_SIZE));
        const parsed = pexelsSearchResponseSchema.safeParse(await fetchPexelsJson(fetchImpl, url.toString(), apiKey));
        if (!parsed.success) throw new PexelsProviderError('Pexels returned an invalid search response');
        candidates = parsed.data.photos.map(normalizePhoto);
        if (candidates.length === 0) throw new PexelsProviderError('Pexels returned no cover candidates');
        cacheCandidates(PEXELS_SEARCH_QUERY, candidates);
    }
    const randomValue = random();
    const index = Number.isFinite(randomValue)
        ? Math.max(0, Math.min(candidates.length - 1, Math.floor(randomValue * candidates.length)))
        : 0;
    return candidates[index];
}

export async function importPexelsCover(
    photoId: number,
    deps: ImportPexelsCoverDependencies,
): Promise<ImportedPublicSessionCover> {
    requireApiKey(deps.apiKey);
    if (!Number.isSafeInteger(photoId) || photoId <= 0) throw new PexelsProviderError('Invalid Pexels photo id');
    const parsed = pexelsPhotoSchema.safeParse(await fetchPexelsJson(
        deps.fetchImpl,
        `${PEXELS_API_ORIGIN}/v1/photos/${photoId}`,
        deps.apiKey,
    ));
    if (!parsed.success || parsed.data.id !== photoId) {
        throw new PexelsProviderError('Pexels returned invalid photo metadata');
    }
    const photo = parsed.data;
    const imageUrl = assertAllowedImageUrl(photo.src.original);
    const source = await fetchBounded(
        deps.fetchImpl,
        imageUrl,
        {},
        'image',
        MAX_IMAGE_RESPONSE_SIZE,
        assertAllowedImageUrl,
    );

    try {
        const sharp = (await import('sharp')).default;
        const image = sharp(source, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height
            || metadata.width > MAX_INPUT_DIMENSION
            || metadata.height > MAX_INPUT_DIMENSION
            || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
            throw new PexelsProviderError('Pexels image dimensions exceed the limit');
        }
        const bytes = await image
            .rotate()
            .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover', position: 'centre' })
            .webp({ quality: 82 })
            .toBuffer();
        if (bytes.length === 0 || bytes.length > MAX_IMPORTED_PUBLIC_SESSION_COVER_SIZE) {
            throw new PexelsProviderError('Pexels cover output exceeds the limit');
        }
        return {
            bytes,
            mimeType: 'image/webp',
            size: bytes.length,
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            attribution: {
                photoId: photo.id,
                photographer: photo.photographer,
                photographerUrl: photo.photographer_url,
                photoUrl: photo.url,
            },
        };
    } catch (error) {
        if (error instanceof PexelsProviderError) throw error;
        throw new PexelsProviderError('Pexels image could not be decoded');
    }
}

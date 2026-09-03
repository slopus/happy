import { beforeAll, describe, expect, it, vi } from 'vitest';

const PHOTO = {
    id: 2014422,
    width: 3024,
    height: 3024,
    url: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
    photographer: 'Eberhard Grossgasteiger',
    photographer_url: 'https://www.pexels.com/@eberhardgross',
    photographer_id: 121938,
    avg_color: '#6E6353',
    src: {
        original: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg',
        large2x: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
        large: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
        medium: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350',
        small: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=130',
        portrait: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800',
        landscape: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200',
        tiny: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280',
    },
    liked: false,
    alt: 'Brown rocks during golden hour',
};

const SECOND_PHOTO = {
    id: 417074,
    width: 4000,
    height: 2667,
    url: 'https://www.pexels.com/photo/scenic-view-of-mountains-during-dawn-417074/',
    photographer: 'Pixabay',
    photographer_url: 'https://www.pexels.com/@pixabay',
    photographer_id: 2659,
    avg_color: null,
    src: {
        original: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg',
        large2x: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
        large: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
        medium: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&h=350',
        small: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&h=130',
        portrait: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800',
        landscape: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200',
        tiny: 'https://images.pexels.com/photos/417074/pexels-photo-417074.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280',
    },
    liked: false,
    alt: 'Scenic view of mountains during dawn',
};

const SEARCH_RESPONSE = {
    page: 1,
    per_page: 30,
    photos: [PHOTO, SECOND_PHOTO],
    total_results: 8000,
    next_page: 'https://api.pexels.com/v1/search/?orientation=landscape&page=2&per_page=30&query=nature',
};

let getRandomPexelsCover: typeof import('./publicSessionCoverProvider').getRandomPexelsCover;
let importPexelsCover: typeof import('./publicSessionCoverProvider').importPexelsCover;

beforeAll(async () => {
    ({ getRandomPexelsCover, importPexelsCover } = await import('./publicSessionCoverProvider'));
});

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

describe('getRandomPexelsCover', () => {
    it('requests landscape photos with server authorization, normalizes attribution, and reuses the pool for 24 hours', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
        const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(SEARCH_RESPONSE));

        try {
            const first = await getRandomPexelsCover(fetchImpl as typeof fetch, 'server-secret', () => 0.75);
            vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
            const second = await getRandomPexelsCover(fetchImpl as typeof fetch, 'server-secret', () => 0);

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [requestUrl, requestInit] = fetchImpl.mock.calls[0];
            const url = new URL(String(requestUrl));
            expect(url.origin + url.pathname).toBe('https://api.pexels.com/v1/search');
            expect(url.searchParams.get('query')).toBe('nature');
            expect(url.searchParams.get('orientation')).toBe('landscape');
            expect(url.searchParams.get('per_page')).toBe('30');
            expect(requestInit).toMatchObject({ headers: { Authorization: 'server-secret' } });
            expect(first).toEqual({
                provider: 'pexels',
                photoId: 417074,
                previewUrl: SECOND_PHOTO.src.landscape,
                width: 4000,
                height: 2667,
                averageColor: null,
                attribution: {
                    photographer: 'Pixabay',
                    photographerUrl: 'https://www.pexels.com/@pixabay',
                    photoUrl: 'https://www.pexels.com/photo/scenic-view-of-mountains-during-dawn-417074/',
                },
            });
            expect(second.photoId).toBe(2014422);
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails before making a request when the API key is missing', async () => {
        const fetchImpl = vi.fn();

        await expect(getRandomPexelsCover(fetchImpl as typeof fetch, '', Math.random)).rejects.toMatchObject({
            name: 'PexelsConfigurationError',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('importPexelsCover', () => {
    it('re-fetches the official photo, autorotates it, and emits a bounded landscape WebP', async () => {
        const sharp = (await import('sharp')).default;
        const source = await sharp({
            create: { width: 3000, height: 1600, channels: 3, background: '#6E6353' },
        }).jpeg().toBuffer();
        const fetchImpl = vi.fn(async (input: string | URL | Request) => (
            new URL(String(input)).hostname === 'api.pexels.com'
                ? jsonResponse(PHOTO)
                : new Response(source, {
                    headers: { 'content-type': 'image/jpeg', 'content-length': String(source.length) },
                })
        ));

        const imported = await importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        });
        const metadata = await sharp(imported.bytes).metadata();

        expect(imported).toMatchObject({
            mimeType: 'image/webp',
            width: 2400,
            height: 900,
            size: imported.bytes.length,
            attribution: {
                photoId: PHOTO.id,
                photographer: PHOTO.photographer,
                photographerUrl: PHOTO.photographer_url,
                photoUrl: PHOTO.url,
            },
        });
        expect(metadata).toMatchObject({ format: 'webp', width: 2400, height: 900 });
    });

    it('rejects an image URL whose hostname is not the Pexels image CDN', async () => {
        const maliciousPhoto = {
            ...PHOTO,
            src: { ...PHOTO.src, original: 'https://attacker.example/private-image' },
        };
        const fetchImpl = vi.fn(async () => jsonResponse(maliciousPhoto));

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('image host');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['embedded credentials', 'https://reader:secret@images.pexels.com/photos/2014422/cover.jpeg'],
        ['a non-HTTPS-default port', 'https://images.pexels.com:444/photos/2014422/cover.jpeg'],
    ])('rejects a Pexels image URL containing %s', async (_reason, original) => {
        const sharp = (await import('sharp')).default;
        const source = await sharp({
            create: { width: 3000, height: 1600, channels: 3, background: '#6E6353' },
        }).jpeg().toBuffer();
        const maliciousPhoto = { ...PHOTO, src: { ...PHOTO.src, original } };
        const fetchImpl = vi.fn(async (input: string | URL | Request) => (
            new URL(String(input)).hostname === 'api.pexels.com'
                ? jsonResponse(maliciousPhoto)
                : new Response(source, { headers: { 'content-type': 'image/jpeg' } })
        ));

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('image host');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('uses manual redirects and never follows a Pexels image redirect to an internal host', async () => {
        const sharp = (await import('sharp')).default;
        const source = await sharp({
            create: { width: 3000, height: 1600, channels: 3, background: '#6E6353' },
        }).jpeg().toBuffer();
        const fetchedUrls: string[] = [];
        const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            fetchedUrls.push(url);
            if (new URL(url).hostname === 'api.pexels.com') return jsonResponse(PHOTO);
            if (new URL(url).hostname === 'images.pexels.com') {
                if (init?.redirect === 'manual') {
                    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
                }
                return fetchImpl('http://127.0.0.1/admin', init);
            }
            return new Response(source, { headers: { 'content-type': 'image/jpeg' } });
        });

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('image host');
        expect(fetchedUrls).not.toContain('http://127.0.0.1/admin');
    });

    it('resolves a relative image redirect only on the allowlisted Pexels image host', async () => {
        const sharp = (await import('sharp')).default;
        const source = await sharp({
            create: { width: 3000, height: 1600, channels: 3, background: '#6E6353' },
        }).jpeg().toBuffer();
        const redirectedUrl = 'https://images.pexels.com/redirected/cover.jpeg';
        let redirectBodyCancelled = false;
        const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);
            if (new URL(url).hostname === 'api.pexels.com') return jsonResponse(PHOTO);
            if (url === PHOTO.src.original) {
                const body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1]));
                    },
                    cancel() {
                        redirectBodyCancelled = true;
                    },
                });
                return new Response(body, { status: 302, headers: { location: '/redirected/cover.jpeg' } });
            }
            if (url === redirectedUrl) {
                return new Response(source, { headers: { 'content-type': 'image/jpeg' } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const imported = await importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        });

        expect(imported.mimeType).toBe('image/webp');
        expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain(redirectedUrl);
        expect(redirectBodyCancelled).toBe(true);
    });

    it('rejects oversized attribution before downloading image bytes', async () => {
        const oversizedPhoto = { ...PHOTO, photographer: 'x'.repeat(201) };
        const fetchImpl = vi.fn(async () => jsonResponse(oversizedPhoto));

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('invalid photo metadata');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['missing', undefined],
        ['invalid', 'http://['],
    ] as const)('fails closed on a %s redirect location', async (_reason, location) => {
        const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
            if (new URL(String(input)).hostname === 'api.pexels.com') return jsonResponse(PHOTO);
            return new Response(null, { status: 302, headers: location ? { location } : {} });
        });

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('redirect location');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects an image redirect chain beyond the bounded hop count', async () => {
        const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
            const url = new URL(String(input));
            if (url.hostname === 'api.pexels.com') return jsonResponse(PHOTO);
            const hop = Number(url.searchParams.get('hop') ?? 0);
            return new Response(null, {
                status: 302,
                headers: { location: `?hop=${hop + 1}` },
            });
        });

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('too many redirects');
    });

    it('rejects a download that is not an image', async () => {
        const fetchImpl = vi.fn(async (input: string | URL | Request) => (
            new URL(String(input)).hostname === 'api.pexels.com'
                ? jsonResponse(PHOTO)
                : new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } })
        ));

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('image content type');
    });

    it('aborts a download whose declared response size exceeds the bound', async () => {
        let imageWasAborted = () => false;
        const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (new URL(String(input)).hostname === 'api.pexels.com') return jsonResponse(PHOTO);
            imageWasAborted = () => init?.signal?.aborted ?? false;
            return new Response(Buffer.from('too large'), {
                headers: { 'content-type': 'image/jpeg', 'content-length': String(21 * 1024 * 1024) },
            });
        });

        await expect(importPexelsCover(PHOTO.id, {
            fetchImpl: fetchImpl as typeof fetch,
            apiKey: 'server-secret',
        })).rejects.toThrow('response is too large');
        expect(imageWasAborted()).toBe(true);
    });
});

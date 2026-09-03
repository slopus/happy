import fastify from 'fastify';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

type ShareRow = {
    id: string;
    publicId: string;
    accountId: string;
    sessionId: string;
    snapshot: unknown;
    activeGeneration: string | null;
    publishedAt: Date | null;
    revokedAt: Date | null;
    lifecycleVersion: number;
    createdAt: Date;
    updatedAt: Date;
};

type DraftRow = {
    id: string;
    shareId: string;
    lifecycleVersion: number;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
};

type AssetRow = {
    id: string;
    shareId: string;
    generation: string;
    name: string;
    mimeType: string;
    kind: string;
    size: number;
    sha256: string;
    uploadedAt: Date | null;
    storagePath: string;
    createdAt: Date;
};

const { state, dbMock, storageMock, providerMock, logMock, resetState } = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        shares: [] as ShareRow[],
        drafts: [] as DraftRow[],
        assets: [] as AssetRow[],
        bytes: new Map<string, Buffer>(),
        nextShare: 1,
    };

    const matches = (value: Record<string, any>, where: Record<string, any>): boolean => Object.entries(where).every(([key, wanted]) => {
        const actual = key === 'share'
            ? state.shares.find((share) => share.id === value.shareId)
            : key === 'draft'
                ? state.drafts.find((draft) => draft.id === value.generation)
                : value[key];
        if (wanted && typeof wanted === 'object' && !Array.isArray(wanted) && !(wanted instanceof Date)) {
            if ('not' in wanted && actual === wanted.not) return false;
            if ('in' in wanted && !wanted.in.includes(actual)) return false;
            if ('gt' in wanted && !(actual > wanted.gt)) return false;
            if ('lte' in wanted && !(actual <= wanted.lte)) return false;
            const operatorKeys = new Set(['not', 'in', 'gt', 'lte']);
            const nested = Object.fromEntries(Object.entries(wanted).filter(([operator]) => !operatorKeys.has(operator)));
            return Object.keys(nested).length === 0 || Boolean(actual && matches(actual, nested));
        }
        return actual === wanted;
    });

    const applyData = (row: Record<string, any>, data: Record<string, any>) => {
        for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
        }
        row.updatedAt = new Date();
    };

    const publicSessionShare = {
        findUnique: vi.fn(async ({ where }: any) => state.shares.find((row) => matches(row, where)) ?? null),
        findFirst: vi.fn(async ({ where }: any) => state.shares.find((row) => matches(row, where)) ?? null),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row: ShareRow = {
                id: `share-${state.nextShare++}`,
                snapshot: null,
                activeGeneration: null,
                publishedAt: null,
                revokedAt: null,
                lifecycleVersion: 1,
                createdAt: now,
                updatedAt: now,
                ...data,
            };
            state.shares.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.shares.find((candidate) => matches(candidate, where));
            if (!row) throw new Error('share missing');
            applyData(row, data);
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const rows = state.shares.filter((row) => matches(row, where));
            rows.forEach((row) => applyData(row, data));
            return { count: rows.length };
        }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
            const row = state.shares.find((candidate) => matches(candidate, where));
            if (!row) throw new Error('share missing');
            return row;
        }),
    };
    const publicSessionShareDraft = {
        findMany: vi.fn(async ({ where, select, take }: any) => {
            const matchingRows = state.drafts.filter((row) => matches(row, where));
            const rows = typeof take === 'number' ? matchingRows.slice(0, take) : matchingRows;
            return select ? rows.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, (row as any)[key]]))) : rows;
        }),
        findFirst: vi.fn(async ({ where }: any) => state.drafts.find((row) => matches(row, where)) ?? null),
        count: vi.fn(async ({ where }: any) => state.drafts.filter((row) => matches(row, where)).length),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row = { createdAt: now, updatedAt: now, ...data } as DraftRow;
            state.drafts.push(row);
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const rows = state.drafts.filter((row) => matches(row, where));
            rows.forEach((row) => applyData(row, data));
            return { count: rows.length };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const deletedIds = state.drafts.filter((row) => matches(row, where)).map((row) => row.id);
            state.drafts = state.drafts.filter((row) => !deletedIds.includes(row.id));
            state.assets = state.assets.filter((asset) => !deletedIds.includes(asset.generation));
            return { count: deletedIds.length };
        }),
    };
    const publicSessionShareAsset = {
        findMany: vi.fn(async ({ where }: any) => state.assets.filter((row) => matches(row, where))),
        findFirst: vi.fn(async ({ where }: any) => state.assets.find((row) => matches(row, where)) ?? null),
        create: vi.fn(async ({ data }: any) => {
            const row = { createdAt: new Date(), uploadedAt: null, ...data } as AssetRow;
            state.assets.push(row);
            return row;
        }),
        aggregate: vi.fn(async ({ where }: any) => ({
            _sum: { size: state.assets.filter((row) => matches(row, where)).reduce((sum, row) => sum + row.size, 0) || null },
        })),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const rows = state.assets.filter((row) => matches(row, where));
            rows.forEach((row) => applyData(row, data));
            return { count: rows.length };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const before = state.assets.length;
            state.assets = state.assets.filter((row) => !matches(row, where));
            return { count: before - state.assets.length };
        }),
    };
    const dbMock: any = {
        session: {
            findFirst: vi.fn(async ({ where }: any) => state.sessions.find((row) => matches(row, where)) ?? null),
        },
        publicSessionShare,
        publicSessionShareDraft,
        publicSessionShareAsset,
    };
    dbMock.$transaction = vi.fn(async (callback: any) => callback(dbMock));

    const storageMock = {
        buildPublicShareStoragePath: vi.fn((shareId: string, generation: string, assetId: string) =>
            `private/session-shares/${shareId}/${generation}/${assetId}`),
        putPublicShareAsset: vi.fn(async (path: string, bytes: Buffer) => { state.bytes.set(path, bytes); }),
        publicShareAssetExists: vi.fn(async (path: string, size: number) => state.bytes.get(path)?.length === size),
        getPublicShareDownloadSource: vi.fn(async (path: string) => {
            const data = state.bytes.get(path);
            if (!data) throw new Error('missing');
            return { kind: 'buffer' as const, data };
        }),
        readPublicShareAssetBytes: vi.fn(async (path: string, maxBytes: number) => {
            const data = state.bytes.get(path);
            if (!data) throw new Error('missing');
            if (data.length > maxBytes) throw new Error('too large');
            return data;
        }),
        deletePublicShareGeneration: vi.fn(async () => undefined),
        deletePublicShareAsset: vi.fn(async (path: string) => { state.bytes.delete(path); }),
        copyPublicShareAsset: vi.fn(async (source: string, destination: string) => {
            const bytes = state.bytes.get(source);
            if (!bytes) throw new Error('missing');
            state.bytes.set(destination, bytes);
        }),
    };

    const providerMock = {
        MAX_IMPORTED_PUBLIC_SESSION_COVER_SIZE: 10 * 1024 * 1024,
        getRandomPexelsCover: vi.fn(async () => ({
            provider: 'pexels' as const,
            photoId: 2014422,
            previewUrl: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg',
            width: 3024,
            height: 3024,
            averageColor: '#6E6353',
            attribution: {
                photographer: 'Eberhard Grossgasteiger',
                photographerUrl: 'https://www.pexels.com/@eberhardgross',
                photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
            },
        })),
        importPexelsCover: vi.fn(async (_photoId: number, _deps?: unknown) => ({
            bytes: Buffer.from('UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoCAAEAAUAmJZQCdAFAAAD+/DeBV/fU6D4r4AAA', 'base64'),
            mimeType: 'image/webp' as const,
            size: 54,
            width: 2,
            height: 1,
            attribution: {
                photoId: 2014422,
                photographer: 'Eberhard Grossgasteiger',
                photographerUrl: 'https://www.pexels.com/@eberhardgross',
                photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
            },
        })),
        PexelsConfigurationError: class PexelsConfigurationError extends Error {},
        PexelsProviderError: class PexelsProviderError extends Error {},
    };
    const logMock = vi.fn();

    const resetState = () => {
        state.sessions = [];
        state.shares = [];
        state.drafts = [];
        state.assets = [];
        state.bytes.clear();
        state.nextShare = 1;
        delete process.env.PEXELS_API_KEY;
        vi.clearAllMocks();
    };
    return { state, dbMock, storageMock, providerMock, logMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/sessionSharing/publicSessionShareStorage', () => storageMock);
vi.mock('@/app/sessionSharing/publicSessionCoverProvider', () => providerMock);
vi.mock('@/utils/log', () => ({ log: logMock }));

import { publicSessionShareRoutes } from './publicSessionShareRoutes';
import { enableErrorHandlers } from '../utils/enableErrorHandlers';

async function createApp() {
    const app = fastify({ bodyLimit: 10 * 1024 * 1024 });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    enableErrorHandlers(typed);
    publicSessionShareRoutes(typed);
    await app.ready();
    return app;
}

const snapshot = (attachmentId?: string) => ({
    version: 1,
    title: 'Shared session',
    sharedAt: 1_777_777_777_777,
    messages: [{
        id: 'message-1',
        role: 'assistant',
        createdAt: 1_777_777_777_000,
        blocks: attachmentId
            ? [{ type: 'attachment', attachmentId, kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', size: 5 }]
            : [{ type: 'text', markdown: 'Hello' }],
    }],
});
const PEXELS_ATTRIBUTION = {
    photoId: 2014422,
    photographer: 'Eberhard Grossgasteiger',
    photographerUrl: 'https://www.pexels.com/@eberhardgross',
    photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
};
const coverSnapshot = (assetId: string, cover: Partial<{
    mimeType: string;
    size: number;
    width: number;
    height: number;
    attribution: typeof PEXELS_ATTRIBUTION;
}> = {}) => ({
    version: 2,
    title: 'Shared session',
    sharedAt: 1_777_777_777_777,
    appearance: {
        themePack: 'sage',
        cover: {
            assetId,
            mimeType: 'image/jpeg',
            size: 5,
            width: 1_200,
            height: 600,
            ...cover,
        },
    },
    messages: [{
        id: 'message-1',
        role: 'assistant',
        createdAt: 1_777_777_777_000,
        blocks: [{ type: 'text', markdown: 'Hello' }],
    }],
});
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const ONE_PIXEL_PNG_SHA256 = createHash('sha256').update(ONE_PIXEL_PNG).digest('hex');
const VALID_IMPORTED_WEBP = Buffer.from(
    'UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoCAAEAAUAmJZQCdAFAAAD+/DeBV/fU6D4r4AAA',
    'base64',
);

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, reject, resolve };
}

describe('publicSessionShareRoutes', () => {
    let app: Awaited<ReturnType<typeof createApp>>;

    beforeEach(async () => {
        resetState();
        state.sessions.push({ id: 'session-1', accountId: 'owner-1' });
        app = await createApp();
    });
    afterEach(async () => app.close());

    async function createDraft(userId = 'owner-1') {
        return app.inject({ method: 'POST', url: '/v1/sessions/session-1/share/drafts', headers: { 'x-user-id': userId } });
    }

    function seedActiveCover(assetId = '51515151-5151-4515-8515-515151515151') {
        const now = new Date();
        const generation = '41414141-4141-4414-8414-414141414141';
        const cover = coverSnapshot(assetId).appearance.cover;
        state.shares.push({
            id: 'share-active-cover',
            publicId: 'a'.repeat(43),
            accountId: 'owner-1',
            sessionId: 'session-1',
            snapshot: coverSnapshot(assetId),
            activeGeneration: generation,
            publishedAt: now,
            revokedAt: null,
            lifecycleVersion: 1,
            createdAt: now,
            updatedAt: now,
        });
        state.drafts.push({
            id: generation,
            shareId: 'share-active-cover',
            lifecycleVersion: 1,
            status: 'published',
            expiresAt: new Date(now.getTime() + 60_000),
            createdAt: now,
            updatedAt: now,
        });
        const storagePath = `private/session-shares/share-active-cover/${generation}/${assetId}`;
        state.assets.push({
            id: assetId,
            shareId: 'share-active-cover',
            generation,
            name: 'cover.jpg',
            mimeType: cover.mimeType,
            kind: 'image',
            size: cover.size,
            sha256: HELLO_SHA256,
            uploadedAt: now,
            storagePath,
            createdAt: now,
        });
        state.bytes.set(storagePath, Buffer.from('hello'));
        return { assetId, cover, generation, storagePath };
    }

    it('allows only the session owner to create a draft', async () => {
        expect((await createDraft('other-user')).statusCode).toBe(404);
        const response = await createDraft();
        expect(response.statusCode).toBe(200);
        expect(response.json().generation).toMatch(/^[0-9a-f-]{36}$/);
        expect(response.json().publicId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(dbMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    });

    it('returns a normalized random Pexels candidate only to the session owner', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';

        const hidden = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1/share/covers/random',
            headers: { 'x-user-id': 'other-user' },
        });
        const response = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1/share/covers/random',
            headers: { 'x-user-id': 'owner-1' },
        });

        expect(hidden.statusCode).toBe(404);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            provider: 'pexels',
            photoId: 2014422,
            attribution: { photographer: 'Eberhard Grossgasteiger' },
        });
    });

    it('clones only the owner active snapshot cover into the current pending draft', async () => {
        const active = seedActiveCover();
        const draft = (await createDraft()).json();

        const hidden = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'other-user' },
            payload: { assetId: active.assetId },
        });
        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });

        expect(hidden.statusCode).toBe(404);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(active.cover);
        const cloned = state.assets.find((asset) => asset.generation === draft.generation);
        expect(cloned).toMatchObject({
            id: active.assetId,
            shareId: 'share-active-cover',
            generation: draft.generation,
            mimeType: active.cover.mimeType,
            size: active.cover.size,
            uploadedAt: expect.any(Date),
        });
        expect(storageMock.copyPublicShareAsset).toHaveBeenCalledWith(active.storagePath, cloned?.storagePath);
    });

    it('rejects no-cover, non-snapshot assets, and stale destination drafts', async () => {
        const active = seedActiveCover();
        const siblingId = '61616161-6161-4616-8616-616161616161';
        state.assets.push({
            ...state.assets[0],
            id: siblingId,
            storagePath: `${state.assets[0].storagePath}-sibling`,
        });
        state.bytes.set(state.assets[1].storagePath, Buffer.from('hello'));
        const draft = (await createDraft()).json();

        const wrongSource = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: siblingId },
        });
        state.shares[0].snapshot = { ...snapshot(), version: 2, appearance: { themePack: 'sage' } };
        const noCover = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });
        state.shares[0].snapshot = coverSnapshot(active.assetId);
        state.drafts.find((row) => row.id === draft.generation)!.status = 'superseded';
        const stale = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });

        expect(wrongSource.statusCode).toBe(409);
        expect(noCover.statusCode).toBe(409);
        expect(stale.statusCode).toBe(409);
        expect(storageMock.copyPublicShareAsset).not.toHaveBeenCalled();
    });

    it.each(['pending-row', 'missing-object'] as const)('rejects an active cover with an incomplete %s source', async (failure) => {
        const active = seedActiveCover();
        if (failure === 'pending-row') state.assets[0].uploadedAt = null;
        else state.bytes.delete(active.storagePath);
        const draft = (await createDraft()).json();

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });

        expect(response.statusCode).toBe(409);
        expect(storageMock.copyPublicShareAsset).not.toHaveBeenCalled();
    });

    it('returns the canonical cloned cover on an idempotent retry without another storage copy', async () => {
        const active = seedActiveCover();
        const draft = (await createDraft()).json();
        const request = {
            method: 'POST' as const,
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        };

        const first = await app.inject(request);
        const retry = await app.inject(request);

        expect(first.statusCode).toBe(200);
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual(first.json());
        expect(storageMock.copyPublicShareAsset).toHaveBeenCalledTimes(1);
        expect(state.assets.filter((asset) => asset.generation === draft.generation)).toHaveLength(1);
    });

    it('lets overlapping clone requests share one completed copy without deleting it', async () => {
        const active = seedActiveCover();
        const draft = (await createDraft()).json();
        const copyEntered = deferred();
        const releaseCopy = deferred();
        let copyCalls = 0;
        const request = {
            method: 'POST' as const,
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        };

        await storageMock.copyPublicShareAsset.withImplementation(async (source: string, destination: string) => {
            copyCalls += 1;
            if (copyCalls === 1) {
                copyEntered.resolve();
                await releaseCopy.promise;
            }
            const bytes = state.bytes.get(source);
            if (!bytes) throw new Error('missing');
            state.bytes.set(destination, bytes);
        }, async () => {
            const firstPromise = app.inject(request);
            await copyEntered.promise;
            const secondPromise = app.inject(request);
            await new Promise((resolve) => setTimeout(resolve, 20));
            releaseCopy.resolve();
            const [first, second] = await Promise.all([firstPromise, secondPromise]);

            expect(first.statusCode).toBe(200);
            expect(second.statusCode).toBe(200);
        });

        expect(copyCalls).toBe(1);
        const completed = state.assets.find((asset) => asset.generation === draft.generation);
        expect(completed?.uploadedAt).toBeInstanceOf(Date);
        expect(state.bytes.get(completed!.storagePath)).toEqual(Buffer.from('hello'));
        expect(storageMock.deletePublicShareAsset).not.toHaveBeenCalledWith(completed!.storagePath);
    });

    it.each(['storage', 'finalization'] as const)(
        'does not delete a peer-completed clone when an expired claimant loses during %s',
        async (failure) => {
            const initialNow = Date.now();
            const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
            try {
                const active = seedActiveCover();
                const draft = (await createDraft()).json();
                const firstCopyEntered = deferred();
                const releaseFirstCopy = deferred();
                let copyCalls = 0;
                const request = {
                    method: 'POST' as const,
                    url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
                    headers: { 'x-user-id': 'owner-1' },
                    payload: { assetId: active.assetId },
                };

                await storageMock.copyPublicShareAsset.withImplementation(async (source: string, destination: string) => {
                    copyCalls += 1;
                    if (copyCalls === 1) {
                        firstCopyEntered.resolve();
                        if (failure === 'finalization') {
                            const bytes = state.bytes.get(source);
                            if (!bytes) throw new Error('missing');
                            state.bytes.set(destination, bytes);
                        }
                        await releaseFirstCopy.promise;
                        if (failure === 'storage') throw new Error('first copy failed late');
                        return;
                    }
                    const bytes = state.bytes.get(source);
                    if (!bytes) throw new Error('missing');
                    state.bytes.set(destination, bytes);
                }, async () => {
                    const firstPromise = app.inject(request);
                    await firstCopyEntered.promise;
                    now.mockReturnValue(initialNow + 3 * 60 * 1000);
                    const second = await app.inject(request);
                    expect(second.statusCode).toBe(200);
                    releaseFirstCopy.resolve();
                    const first = await firstPromise;
                    expect(first.statusCode).toBe(200);
                });

                expect(copyCalls).toBe(2);
                const completed = state.assets.find((asset) => asset.generation === draft.generation);
                expect(completed?.uploadedAt).toBeInstanceOf(Date);
                expect(state.bytes.get(completed!.storagePath)).toEqual(Buffer.from('hello'));
                expect(storageMock.deletePublicShareAsset).not.toHaveBeenCalledWith(completed!.storagePath);
            } finally {
                now.mockRestore();
            }
        },
    );

    it('re-reads a canonical peer completion after a unique-claim collision', async () => {
        const active = seedActiveCover();
        const draft = (await createDraft()).json();
        const originalCreate = dbMock.publicSessionShareAsset.create.getMockImplementation();
        dbMock.publicSessionShareAsset.create.mockImplementationOnce(async ({ data }: any) => {
            const completed = {
                createdAt: new Date(),
                ...data,
                name: state.assets[0].name,
                uploadedAt: new Date(),
            } as AssetRow;
            state.assets.push(completed);
            state.bytes.set(completed.storagePath, Buffer.from('hello'));
            throw Object.assign(new Error('unique collision'), { code: 'P2002' });
        });

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });

        expect(response.statusCode).toBe(200);
        expect(storageMock.copyPublicShareAsset).not.toHaveBeenCalled();
        const completed = state.assets.find((asset) => asset.generation === draft.generation);
        expect(state.bytes.get(completed!.storagePath)).toEqual(Buffer.from('hello'));
        expect(storageMock.deletePublicShareAsset).not.toHaveBeenCalledWith(completed!.storagePath);
        if (originalCreate) dbMock.publicSessionShareAsset.create.mockImplementation(originalCreate);
    });

    it('recovers an ambiguous clone finalization after the bounded claim lease', async () => {
        const initialNow = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
        try {
            const active = seedActiveCover();
            const draft = (await createDraft()).json();
            let transactionCall = 0;
            dbMock.$transaction.mockImplementation(async (callback: any) => {
                transactionCall += 1;
                if (transactionCall === 2) throw new Error('clone finalization result unknown');
                return callback(dbMock);
            });
            const request = {
                method: 'POST' as const,
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
                headers: { 'x-user-id': 'owner-1' },
                payload: { assetId: active.assetId },
            };

            const ambiguous = await app.inject(request);
            expect(ambiguous.statusCode).toBe(500);
            const retained = state.assets.find((asset) => asset.generation === draft.generation);
            expect(retained?.uploadedAt).toBeNull();
            expect(state.bytes.get(retained!.storagePath)).toEqual(Buffer.from('hello'));

            dbMock.$transaction.mockImplementation(async (callback: any) => callback(dbMock));
            now.mockReturnValue(initialNow + 3 * 60 * 1000);
            const recovered = await app.inject(request);

            expect(recovered.statusCode).toBe(200);
            const completed = state.assets.find((asset) => asset.generation === draft.generation);
            expect(completed?.uploadedAt).toBeInstanceOf(Date);
            expect(state.bytes.get(completed!.storagePath)).toEqual(Buffer.from('hello'));
        } finally {
            now.mockRestore();
        }
    });

    it('keeps the active publication unchanged and the destination unpublished when clone storage fails', async () => {
        const active = seedActiveCover();
        const originalSnapshot = state.shares[0].snapshot;
        const originalPublishedAt = state.shares[0].publishedAt;
        const draft = (await createDraft()).json();
        storageMock.copyPublicShareAsset.mockRejectedValueOnce(new Error('copy unavailable'));

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: active.assetId },
        });

        expect(response.statusCode).toBe(503);
        expect(state.shares[0]).toMatchObject({ snapshot: originalSnapshot, publishedAt: originalPublishedAt });
        expect(state.drafts.find((row) => row.id === draft.generation)?.status).toBe('pending');
        expect(state.assets.filter((asset) => asset.generation === draft.generation)).toHaveLength(0);
    });

    it('returns 503 for an unconfigured random provider without disabling other share routes', async () => {
        const unavailable = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1/share/covers/random',
            headers: { 'x-user-id': 'owner-1' },
        });
        const share = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1/share',
            headers: { 'x-user-id': 'owner-1' },
        });

        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({ error: 'Random cover provider is unavailable' });
        expect(share.statusCode).toBe(200);
        expect(share.json()).toMatchObject({ active: false });
    });

    it('imports a canonical WebP into the pending generation outside a database transaction', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const hidden = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'other-user' },
            payload: { assetId: '77777777-7777-4777-8777-777777777777', photoId: 2014422 },
        });
        expect(hidden.statusCode).toBe(404);
        let transactionActive = false;
        dbMock.$transaction.mockImplementation(async (callback: any) => {
            transactionActive = true;
            try {
                return await callback(dbMock);
            } finally {
                transactionActive = false;
            }
        });
        providerMock.importPexelsCover.mockImplementationOnce(async () => {
            expect(transactionActive).toBe(false);
            return {
                bytes: Buffer.from('webp'), mimeType: 'image/webp', size: 4, width: 2400, height: 900,
                attribution: {
                    photoId: 2014422,
                    photographer: 'Eberhard Grossgasteiger',
                    photographerUrl: 'https://www.pexels.com/@eberhardgross',
                    photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
                },
            };
        });
        storageMock.putPublicShareAsset.mockImplementationOnce(async (path: string, bytes: Buffer) => {
            expect(transactionActive).toBe(false);
            state.bytes.set(path, bytes);
        });

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '77777777-7777-4777-8777-777777777777', photoId: 2014422 },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            assetId: '77777777-7777-4777-8777-777777777777',
            mimeType: 'image/webp',
            size: 4,
            width: 2400,
            height: 900,
            attribution: {
                photoId: 2014422,
                photographer: 'Eberhard Grossgasteiger',
                photographerUrl: 'https://www.pexels.com/@eberhardgross',
                photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
            },
        });
        expect(state.assets).toHaveLength(1);
        expect(state.assets[0]).toMatchObject({
            id: '77777777-7777-4777-8777-777777777777',
            generation: draft.generation,
            mimeType: 'image/webp',
            kind: 'image',
            size: 4,
            sha256: 'a57bb082e728a0cdce930ecfcccf4510a3a247be5f322b09b3a971a3f5ed34f8',
            uploadedAt: expect.any(Date),
        });
        expect(state.bytes.get(state.assets[0].storagePath)).toEqual(Buffer.from('webp'));
    });

    it('reserves the maximum transformed cover size before calling Pexels and releases it after failure', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const entered = deferred();
        const release = deferred();
        providerMock.importPexelsCover.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            throw new providerMock.PexelsProviderError('provider unavailable');
        });

        const responsePromise = app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: crypto.randomUUID(), photoId: 2014422 },
        });
        await entered.promise;

        expect(state.assets).toHaveLength(1);
        expect(state.assets[0].size).toBe(10 * 1024 * 1024);
        release.resolve();
        expect((await responsePromise).statusCode).toBe(502);
        expect(state.assets).toHaveLength(0);
    });

    it('rejects pending-account quota exhaustion before making a provider request', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        dbMock.publicSessionShareAsset.aggregate.mockResolvedValueOnce({
            _sum: { size: 2 * 1024 * 1024 * 1024 - 10 * 1024 * 1024 + 1 },
        });

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: crypto.randomUUID(), photoId: 2014422 },
        });

        expect(response.statusCode).toBe(413);
        expect(response.json()).toEqual({ error: 'Pending shared-session storage limit exceeded' });
        expect(providerMock.importPexelsCover).not.toHaveBeenCalled();
        expect(state.assets).toHaveLength(0);
    });

    it('rate-limits many distinct cover asset IDs by account with Retry-After', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const responses = [];
        for (let index = 0; index < 21; index += 1) {
            responses.push(await app.inject({
                method: 'POST',
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
                headers: { 'x-user-id': 'owner-1' },
                payload: {
                    assetId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                    photoId: 2014422,
                },
            }));
        }

        expect(responses.slice(0, 20).every((response) => response.statusCode === 200)).toBe(true);
        expect(responses[20].statusCode).toBe(429);
        expect(Number(responses[20].headers['retry-after'])).toBeGreaterThan(0);
        expect(providerMock.importPexelsCover).toHaveBeenCalledTimes(20);
    });

    it('removes only the imported object when the draft becomes stale during provider work', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const siblingPath = `private/session-shares/${state.shares[0].id}/${draft.generation}/sibling`;
        state.bytes.set(siblingPath, Buffer.from('attachment'));
        storageMock.putPublicShareAsset.mockImplementationOnce(async (path: string, bytes: Buffer) => {
            state.bytes.set(path, bytes);
            state.drafts[0].status = 'superseded';
        });

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', photoId: 2014422 },
        });

        expect(response.statusCode).toBe(409);
        expect(storageMock.deletePublicShareAsset).toHaveBeenCalledWith(
            expect.stringContaining(
                `private/session-shares/${state.shares[0].id}/${draft.generation}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_`,
            ),
        );
        expect(state.bytes.get(siblingPath)).toEqual(Buffer.from('attachment'));
        expect(state.assets).toHaveLength(0);
    });

    it('returns canonical metadata when the same imported asset ID is retried', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const request = {
            method: 'POST' as const,
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '88888888-8888-4888-8888-888888888888', photoId: 2014422 },
        };

        const first = await app.inject(request);
        providerMock.importPexelsCover.mockClear();
        storageMock.putPublicShareAsset.mockClear();
        const retry = await app.inject(request);

        expect(first.statusCode).toBe(200);
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual(first.json());
        expect(state.assets).toHaveLength(1);
        expect(providerMock.importPexelsCover).not.toHaveBeenCalled();
        expect(storageMock.putPublicShareAsset).not.toHaveBeenCalled();
    });

    it('recovers an abandoned claim after its bounded lease and completes canonically', async () => {
        const initialNow = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
        try {
            process.env.PEXELS_API_KEY = 'server-secret';
            const draft = (await createDraft()).json();
            let transactionCall = 0;
            dbMock.$transaction.mockImplementation(async (callback: any) => {
                transactionCall += 1;
                if (transactionCall === 2) throw new Error('finalization result unknown');
                return callback(dbMock);
            });
            const request = {
                method: 'POST' as const,
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
                headers: { 'x-user-id': 'owner-1' },
                payload: { assetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', photoId: 2014422 },
            };

            const ambiguous = await app.inject(request);
            expect(ambiguous.statusCode).toBe(500);
            expect(state.assets).toHaveLength(1);
            expect(state.assets[0].uploadedAt).toBeNull();

            dbMock.$transaction.mockImplementation(async (callback: any) => callback(dbMock));
            providerMock.importPexelsCover.mockClear();
            now.mockReturnValue(initialNow + 3 * 60 * 1000);
            const recovered = await app.inject(request);

            expect(recovered.statusCode).toBe(200);
            expect(providerMock.importPexelsCover).toHaveBeenCalledTimes(1);
            expect(state.assets).toHaveLength(1);
            expect(state.assets[0].uploadedAt).toBeInstanceOf(Date);
            expect(state.bytes.get(state.assets[0].storagePath)).toEqual(VALID_IMPORTED_WEBP);
        } finally {
            now.mockRestore();
        }
    });

    it('logs a failed claim release and recovers it after the bounded lease', async () => {
        const initialNow = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
        try {
            process.env.PEXELS_API_KEY = 'server-secret';
            const draft = (await createDraft()).json();
            providerMock.importPexelsCover.mockRejectedValueOnce(new providerMock.PexelsProviderError('provider unavailable'));
            dbMock.publicSessionShareAsset.deleteMany.mockRejectedValueOnce(new Error('database unavailable'));
            const request = {
                method: 'POST' as const,
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
                headers: { 'x-user-id': 'owner-1' },
                payload: { assetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', photoId: 2014422 },
            };

            const failed = await app.inject(request);
            expect(failed.statusCode).toBe(502);
            expect(state.assets).toHaveLength(1);
            expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
                module: 'public-session-cover-claim-release',
                assetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            }), expect.stringContaining('lease recovery'));

            now.mockReturnValue(initialNow + 3 * 60 * 1000);
            const recovered = await app.inject(request);

            expect(recovered.statusCode).toBe(200);
            expect(state.assets).toHaveLength(1);
            expect(state.assets[0].uploadedAt).toBeInstanceOf(Date);
        } finally {
            now.mockRestore();
        }
    });

    it('atomically claims an asset ID so a concurrent loser cannot overwrite or delete the winner object', async () => {
        const initialNow = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
        try {
            process.env.PEXELS_API_KEY = 'server-secret';
            const draft = (await createDraft()).json();
            let releaseProvider!: () => void;
            let providerEntered!: () => void;
            const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
            const released = new Promise<void>((resolve) => { releaseProvider = resolve; });

            await providerMock.importPexelsCover.withImplementation(async (photoId: number) => {
                if (photoId === 2014422) {
                    providerEntered();
                    await released;
                    return {
                        bytes: Buffer.from('webp'), mimeType: 'image/webp', size: 4, width: 2400, height: 900,
                        attribution: {
                            photoId: 2014422,
                            photographer: 'Eberhard Grossgasteiger',
                            photographerUrl: 'https://www.pexels.com/@eberhardgross',
                            photoUrl: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
                        },
                    };
                }
                return {
                    bytes: Buffer.from('other'), mimeType: 'image/webp', size: 5, width: 2400, height: 900,
                    attribution: {
                        photoId: 417074,
                        photographer: 'Pixabay',
                        photographerUrl: 'https://www.pexels.com/@pixabay',
                        photoUrl: 'https://www.pexels.com/photo/scenic-view-of-mountains-during-dawn-417074/',
                    },
                };
            }, async () => {
                const url = `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`;
                const firstPromise = app.inject({
                    method: 'POST', url, headers: { 'x-user-id': 'owner-1' },
                    payload: { assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', photoId: 2014422 },
                });
                await entered;
                now.mockReturnValue(initialNow + 30_000);
                const concurrent = await app.inject({
                    method: 'POST', url, headers: { 'x-user-id': 'owner-1' },
                    payload: { assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', photoId: 417074 },
                });
                releaseProvider();
                const first = await firstPromise;

                expect(first.statusCode).toBe(200);
                expect(concurrent.statusCode).toBe(409);
            });

            expect(providerMock.importPexelsCover).toHaveBeenCalledTimes(1);
            expect(storageMock.deletePublicShareAsset).not.toHaveBeenCalled();
            expect(state.assets).toHaveLength(1);
            expect(state.assets[0].uploadedAt).toBeInstanceOf(Date);
            expect(state.bytes.get(state.assets[0].storagePath)).toEqual(Buffer.from('webp'));
        } finally {
            now.mockRestore();
        }
    });

    it('rejects provider metadata that exceeds the internal byte bound even within field lengths', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const unicodeUrl = `https://www.pexels.com/${'界'.repeat(900)}`;
        await providerMock.importPexelsCover.withImplementation(async () => ({
            bytes: Buffer.from('webp'), mimeType: 'image/webp' as const, size: 4, width: 2400, height: 900,
            attribution: {
                photoId: 2014422,
                photographer: 'x'.repeat(200),
                photographerUrl: unicodeUrl,
                photoUrl: unicodeUrl,
            },
        }), async () => {
            const response = await app.inject({
                method: 'POST',
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
                headers: { 'x-user-id': 'owner-1' },
                payload: { assetId: '12121212-1212-4212-8212-121212121212', photoId: 2014422 },
            });

            expect(response.statusCode).toBe(502);
        });
        expect(storageMock.putPublicShareAsset).not.toHaveBeenCalled();
        expect(state.assets).toHaveLength(0);
    });

    it('uses a fixed safe filename instead of internal Pexels metadata when serving a cover', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const imported = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '13131313-1313-4313-8313-131313131313', photoId: 2014422 },
        })).json();
        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(imported.assetId, {
                    mimeType: imported.mimeType,
                    size: imported.size,
                    width: imported.width,
                    height: imported.height,
                    attribution: imported.attribution,
                }),
            },
        });
        expect(publish.statusCode).toBe(200);

        const response = await app.inject({
            method: 'GET',
            url: `/v1/public/session-shares/${draft.publicId}/attachments/${imported.assetId}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['content-disposition']).toContain('filename="cover.webp"');
        expect(response.headers['content-disposition']).not.toContain('pexels-cover-v1');
        expect(response.headers['content-disposition']).not.toContain('__paws_internal__');
    });

    it('serves an accepted AVIF cover inline with hardened response headers', async () => {
        const bytes = await sharp({
            create: { width: 1, height: 1, channels: 3, background: { r: 50, g: 60, b: 70 } },
        }).avif().toBuffer();
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '14141414-1414-4414-8414-141414141414',
                name: 'cover.avif',
                mimeType: 'image/avif',
                kind: 'image',
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
        })).json();
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: bytes,
        });
        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(asset.assetId, {
                    mimeType: 'image/avif', size: bytes.length, width: 1, height: 1,
                }),
            },
        });
        expect(publish.statusCode).toBe(200);

        const response = await app.inject({
            method: 'GET',
            url: `/v1/public/session-shares/${draft.publicId}/attachments/${asset.assetId}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('image/avif');
        expect(response.headers['content-disposition']).toContain('inline');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['cache-control']).toBe('no-store');
    });

    it.each(['provider', 'storage'] as const)('leaves the draft unpublished when %s work fails', async (failure) => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        if (failure === 'provider') {
            providerMock.importPexelsCover.mockRejectedValueOnce(new providerMock.PexelsProviderError('provider unavailable'));
        } else {
            storageMock.putPublicShareAsset.mockRejectedValueOnce(new Error('object store unavailable'));
        }

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '99999999-9999-4999-8999-999999999999', photoId: 2014422 },
        });

        expect(response.statusCode).toBeGreaterThanOrEqual(500);
        expect(state.shares[0].publishedAt).toBeNull();
        expect(state.drafts[0].status).toBe('pending');
        expect(state.assets).toHaveLength(0);
        if (failure === 'storage') {
            expect(storageMock.deletePublicShareAsset).toHaveBeenCalledWith(
                expect.stringContaining(
                    `private/session-shares/${state.shares[0].id}/${draft.generation}/99999999-9999-4999-8999-999999999999_`,
                ),
            );
        }
    });

    it('retains a durable claim and logs when partial-object cleanup must be deferred', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        storageMock.putPublicShareAsset.mockRejectedValueOnce(new Error('object store unavailable'));
        storageMock.deletePublicShareAsset.mockRejectedValueOnce(new Error('cleanup unavailable'));

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', photoId: 2014422 },
        });

        expect(response.statusCode).toBe(503);
        expect(state.assets).toHaveLength(1);
        expect(state.assets[0].uploadedAt).toBeNull();
        expect(logMock).toHaveBeenCalledWith(expect.objectContaining({
            module: 'public-session-cover-import-cleanup',
            level: 'error',
            shareId: state.shares[0].id,
            generation: draft.generation,
            assetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }), expect.stringContaining('retaining the draft asset for retry'));
    });

    it('retries a serializable quota transaction after a database write conflict', async () => {
        dbMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' }));

        const response = await createDraft();

        expect(response.statusCode).toBe(200);
        expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
    });

    it('rejects arbitrary generations and attachment checksum mismatches', async () => {
        const draft = (await createDraft()).json();
        const arbitraryGeneration = '11111111-1111-4111-8111-111111111111';
        const arbitrary = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${arbitraryGeneration}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '22222222-2222-4222-8222-222222222222',
                name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        });
        expect(arbitrary.statusCode).toBe(409);

        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '33333333-3333-4333-8333-333333333333',
                name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: 'a'.repeat(64),
            },
        })).json();
        const upload = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });
        expect(upload.statusCode).toBe(400);
        expect(upload.json().error).toContain('checksum');
    });

    it.each([
        '__paws_internal__:pexels-cover-v1:forged',
        'folder/__paws_internal__:pexels-claim-v1:forged',
        'folder\\pexels-cover-v1:forged',
        '../pexels-cover-pending:forged',
    ])('rejects client attachment names whose normalized basename is reserved: %s', async (name) => {
        const draft = (await createDraft()).json();

        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                name,
                mimeType: 'image/webp',
                kind: 'image',
                size: 4,
                sha256: 'a57bb082e728a0cdce930ecfcccf4510a3a247be5f322b09b3a971a3f5ed34f8',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(state.assets).toHaveLength(0);
    });

    it('normalizes both path separators without decoding percent-looking ordinary names', async () => {
        const draft = (await createDraft()).json();
        const response = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                name: 'folder\\report%20final.pdf',
                mimeType: 'application/pdf',
                kind: 'file',
                size: 4,
                sha256: 'a57bb082e728a0cdce930ecfcccf4510a3a247be5f322b09b3a971a3f5ed34f8',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(state.assets[0]?.name).toBe('report%20final.pdf');
    });

    it('keeps drafts private and publishes only after every manifest asset exists', async () => {
        const draft = (await createDraft()).json();
        const prepared = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '22222222-2222-4222-8222-222222222222',
                name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        });
        expect(prepared.statusCode).toBe(200);
        expect(dbMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
        const asset = prepared.json();
        expect(asset.assetId).toBe('22222222-2222-4222-8222-222222222222');

        const privateDraft = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}` });
        expect(privateDraft.statusCode).toBe(404);
        expect(privateDraft.headers['cache-control']).toBe('no-store');
        expect(privateDraft.headers['x-robots-tag']).toContain('noindex');
        const beforeUpload = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: snapshot(asset.assetId) },
        });
        expect(beforeUpload.statusCode).toBe(409);

        const upload = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });
        expect(upload.statusCode).toBe(200);

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: snapshot(asset.assetId) },
        });
        expect(publish.statusCode).toBe(200);

        const publicResponse = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}` });
        expect(publicResponse.statusCode).toBe(200);
        expect(publicResponse.json().snapshot).toEqual(snapshot(asset.assetId));
        expect(publicResponse.headers['cache-control']).toBe('no-store');
        expect(publicResponse.headers['x-robots-tag']).toContain('noindex');
    });

    it('publishes a cover that is the only asset in the manifest', async () => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '55555555-5555-4555-8555-555555555555',
                name: 'cover.png', mimeType: 'image/png', kind: 'image', size: ONE_PIXEL_PNG.length, sha256: ONE_PIXEL_PNG_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: ONE_PIXEL_PNG,
        });

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(asset.assetId, {
                    mimeType: 'image/png',
                    size: ONE_PIXEL_PNG.length,
                    width: 1,
                    height: 1,
                }),
            },
        });

        expect(publish.statusCode).toBe(200);
    });

    it.each([
        ['corrupt bytes', Buffer.alloc(ONE_PIXEL_PNG.length, 1), 'image/png', 1, 1],
        ['mislabeled format', ONE_PIXEL_PNG, 'image/jpeg', 1, 1],
        ['dimension mismatch', ONE_PIXEL_PNG, 'image/png', 2, 1],
    ] as const)('rejects an uploaded cover with %s before publication', async (_case, bytes, mimeType, width, height) => {
        const draft = (await createDraft()).json();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const assetId = crypto.randomUUID();
        await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: assetId,
                name: 'cover.png',
                mimeType,
                kind: 'image',
                size: bytes.length,
                sha256,
            },
        });
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: bytes,
        });

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(assetId, { mimeType, size: bytes.length, width, height }),
            },
        });

        expect(publish.statusCode).toBe(409);
        expect(publish.json()).toEqual({ error: 'Shared cover validation failed' });
        expect(state.shares[0].publishedAt).toBeNull();
    });

    it.each([
        '__paws_internal__:pexels-cover-v1:not-base64!',
        '__paws_internal__:pexels-claim-v1:not-base64!',
        '__paws_internal__:clone-claim-v1:not-base64!',
        'pexels-cover-v1:not-base64!',
        'pexels-cover-pending:not-base64!',
    ])('rejects a cover asset with malformed reserved metadata in %s', async (reservedName) => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: crypto.randomUUID(),
                name: 'cover.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });
        const storedAsset = state.assets.find((candidate) => candidate.id === asset.assetId);
        if (!storedAsset) throw new Error('prepared cover asset is missing');
        storedAsset.name = reservedName;

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: coverSnapshot(asset.assetId) },
        });

        expect(publish.statusCode).toBe(409);
        expect(publish.json()).toEqual({ error: 'Shared attachment metadata mismatch' });
    });

    it('rejects Pexels attribution attached to an ordinary uploaded cover', async () => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '56565656-5656-4565-8565-565656565656',
                name: 'cover.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: coverSnapshot(asset.assetId, { attribution: PEXELS_ATTRIBUTION }) },
        });

        expect(publish.statusCode).toBe(409);
    });

    it('requires canonical attribution when publishing an imported Pexels cover', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const imported = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '57575757-5757-4575-8575-575757575757', photoId: 2014422 },
        })).json();

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(imported.assetId, {
                    mimeType: imported.mimeType,
                    size: imported.size,
                    width: imported.width,
                    height: imported.height,
                }),
            },
        });

        expect(publish.statusCode).toBe(409);
    });

    it.each(['same-length corruption', 'wrong dimensions', 'wrong format'] as const)(
        'validates canonical imported cover bytes and rejects %s',
        async (failure) => {
            process.env.PEXELS_API_KEY = 'server-secret';
            const draft = (await createDraft()).json();
            const imported = (await app.inject({
                method: 'POST',
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
                headers: { 'x-user-id': 'owner-1' },
                payload: { assetId: crypto.randomUUID(), photoId: 2014422 },
            })).json();
            const asset = state.assets.find((candidate) => candidate.id === imported.assetId)!;
            let replacement: Buffer;
            if (failure === 'same-length corruption') {
                replacement = Buffer.alloc(imported.size, 0x61);
            } else if (failure === 'wrong dimensions') {
                replacement = await sharp({
                    create: { width: 1, height: 1, channels: 3, background: { r: 20, g: 30, b: 40 } },
                }).webp().toBuffer();
                asset.size = replacement.length;
                asset.sha256 = createHash('sha256').update(replacement).digest('hex');
            } else {
                replacement = await sharp({
                    create: {
                        width: imported.width,
                        height: imported.height,
                        channels: 3,
                        background: { r: 20, g: 30, b: 40 },
                    },
                }).png().toBuffer();
                asset.size = replacement.length;
                asset.sha256 = createHash('sha256').update(replacement).digest('hex');
            }
            state.bytes.set(asset.storagePath, replacement);

            const publish = await app.inject({
                method: 'PUT',
                url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
                headers: { 'x-user-id': 'owner-1' },
                payload: {
                    snapshot: coverSnapshot(imported.assetId, {
                        mimeType: imported.mimeType,
                        size: replacement.length,
                        width: imported.width,
                        height: imported.height,
                        attribution: imported.attribution,
                    }),
                },
            });

            expect(publish.statusCode).toBe(409);
            expect(publish.json()).toEqual({ error: 'Shared cover validation failed' });
        },
    );

    it.each([
        ['photo URL', { attribution: { ...PEXELS_ATTRIBUTION, photoUrl: 'https://www.pexels.com/photo/another-photo-1/' } }],
        ['photographer', { attribution: { ...PEXELS_ATTRIBUTION, photographer: 'Forged Photographer' } }],
        ['width', { width: 3, attribution: PEXELS_ATTRIBUTION }],
        ['height', { height: 2, attribution: PEXELS_ATTRIBUTION }],
    ] as const)('rejects forged imported Pexels %s metadata', async (_field, forged) => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const draft = (await createDraft()).json();
        const imported = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: crypto.randomUUID(), photoId: 2014422 },
        })).json();

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                snapshot: coverSnapshot(imported.assetId, {
                    mimeType: imported.mimeType,
                    size: imported.size,
                    width: imported.width,
                    height: imported.height,
                    ...forged,
                }),
            },
        });

        expect(publish.statusCode).toBe(409);
    });

    it('preserves canonical Pexels metadata through clone and republishes it', async () => {
        process.env.PEXELS_API_KEY = 'server-secret';
        const firstDraft = (await createDraft()).json();
        const imported = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${firstDraft.generation}/covers/import`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: '58585858-5858-4585-8585-585858585858', photoId: 2014422 },
        })).json();
        const canonicalSnapshot = coverSnapshot(imported.assetId, {
            mimeType: imported.mimeType,
            size: imported.size,
            width: imported.width,
            height: imported.height,
            attribution: imported.attribution,
        });
        const firstPublish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${firstDraft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: canonicalSnapshot },
        });
        expect(firstPublish.statusCode).toBe(200);
        const sourceName = state.assets.find((asset) => asset.generation === firstDraft.generation)?.name;

        const nextDraft = (await createDraft()).json();
        const clone = await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${nextDraft.generation}/covers/clone`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { assetId: imported.assetId },
        });
        expect(clone.statusCode).toBe(200);
        expect(clone.json()).toEqual(imported);
        expect(state.assets.find((asset) => asset.generation === nextDraft.generation)?.name).toBe(sourceName);

        const republish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${nextDraft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: canonicalSnapshot },
        });
        expect(republish.statusCode).toBe(200);
    });

    it('rejects a cover whose registered asset object has not completed upload', async () => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: '66666666-6666-4666-8666-666666666666',
                name: 'cover.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        })).json();

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: coverSnapshot(asset.assetId) },
        });

        expect(publish.statusCode).toBe(409);
        expect(publish.json()).toEqual({ error: 'Shared attachment upload incomplete' });
    });

    it.each([
        ['different MIME type', { kind: 'image', mimeType: 'image/jpeg', size: 5 }, { mimeType: 'image/png' }],
        ['different size', { kind: 'image', mimeType: 'image/jpeg', size: 5 }, { size: 6 }],
        ['non-image asset kind', { kind: 'file', mimeType: 'image/png', size: 5 }, { mimeType: 'image/png' }],
    ] as const)('rejects a cover with a %s from its registered asset', async (_reason, preparedAsset, cover) => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' },
            payload: {
                attachmentId: crypto.randomUUID(),
                name: 'cover.jpg',
                mimeType: preparedAsset.mimeType,
                kind: preparedAsset.kind,
                size: preparedAsset.size,
                sha256: HELLO_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' },
            payload: { snapshot: coverSnapshot(asset.assetId, cover) },
        });

        expect(publish.statusCode).toBe(409);
        expect(publish.json()).toEqual({ error: 'Shared attachment metadata mismatch' });
    });

    it('returns the active version-two appearance snapshot to its owner', async () => {
        const publishedAt = new Date();
        state.shares.push({
            id: 'share-appearance',
            publicId: 'a'.repeat(43),
            accountId: 'owner-1',
            sessionId: 'session-1',
            snapshot: {
                ...snapshot(),
                version: 2,
                appearance: { themePack: 'sage' },
            },
            activeGeneration: '11111111-1111-4111-8111-111111111111',
            publishedAt,
            revokedAt: null,
            lifecycleVersion: 1,
            createdAt: publishedAt,
            updatedAt: publishedAt,
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1/share',
            headers: { 'x-user-id': 'owner-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            active: true,
            appearance: { themePack: 'sage' },
        });
    });

    it('updates the snapshot at the same public URL', async () => {
        const first = (await createDraft()).json();
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${first.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: snapshot() },
        });
        const second = (await createDraft()).json();
        expect(second.publicId).toBe(first.publicId);
        const nextSnapshot = { ...snapshot(), title: 'Updated snapshot' };
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${second.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: nextSnapshot },
        });
        const publicResponse = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${first.publicId}` });
        expect(publicResponse.json().snapshot.title).toBe('Updated snapshot');
    });

    it('revokes immediately and rotates the public id on the next draft', async () => {
        const draft = (await createDraft()).json();
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: snapshot() },
        });
        let transactionActive = false;
        let cleanupMarkerWrittenInTransaction = false;
        dbMock.$transaction.mockImplementationOnce(async (callback: any, options: any) => {
            expect(options).toEqual({ isolationLevel: 'Serializable' });
            transactionActive = true;
            try {
                return await callback(dbMock);
            } finally {
                transactionActive = false;
            }
        });
        dbMock.publicSessionShareDraft.updateMany.mockImplementationOnce(async ({ where, data }: any) => {
            expect(transactionActive).toBe(true);
            cleanupMarkerWrittenInTransaction = data.status === 'revoked';
            const rows = state.drafts.filter((row) => row.shareId === where.shareId);
            rows.forEach((row) => Object.assign(row, data));
            return { count: rows.length };
        });
        expect((await app.inject({ method: 'DELETE', url: '/v1/sessions/session-1/share', headers: { 'x-user-id': 'owner-1' } })).statusCode).toBe(200);
        expect(cleanupMarkerWrittenInTransaction).toBe(true);
        expect((await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}` })).statusCode).toBe(404);

        const next = (await createDraft()).json();
        expect(next.publicId).not.toBe(draft.publicId);
    });

    it('cannot resurrect a revoked link when revoke wins during publish validation', async () => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' }, payload: {
                attachmentId: '44444444-4444-4444-8444-444444444444',
                name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' }, payload: Buffer.from('hello'),
        });
        storageMock.publicShareAssetExists.mockImplementationOnce(async () => {
            const share = state.shares[0];
            share.revokedAt = new Date();
            share.lifecycleVersion += 1;
            return true;
        });

        const publish = await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: snapshot(asset.assetId) },
        });

        expect(publish.statusCode).toBe(409);
        expect(state.shares[0].revokedAt).toBeInstanceOf(Date);
        expect(state.shares[0].publishedAt).toBeNull();
    });

    it('still revokes when publishing changes the lifecycle immediately before the revoke update', async () => {
        const draft = (await createDraft()).json();
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: snapshot() },
        });
        dbMock.publicSessionShare.updateMany.mockImplementationOnce(async ({ where, data }: any) => {
            const share = state.shares[0];
            // Simulate a concurrent publish committing after DELETE read the
            // share but before its update reached the database.
            share.lifecycleVersion += 1;
            share.publishedAt = new Date();
            if (where.lifecycleVersion !== undefined && where.lifecycleVersion !== share.lifecycleVersion) return { count: 0 };
            if (where.revokedAt === null && share.revokedAt !== null) return { count: 0 };
            share.revokedAt = data.revokedAt;
            share.lifecycleVersion += data.lifecycleVersion.increment;
            return { count: 1 };
        });

        const revoke = await app.inject({
            method: 'DELETE', url: '/v1/sessions/session-1/share', headers: { 'x-user-id': 'owner-1' },
        });

        expect(revoke.statusCode).toBe(200);
        expect(state.shares[0].revokedAt).toBeInstanceOf(Date);
        expect((await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}` })).statusCode).toBe(404);
    });

    it('serves safe attachment headers and hides unknown links behind the same 404', async () => {
        const draft = (await createDraft()).json();
        const asset = (await app.inject({
            method: 'POST', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets`,
            headers: { 'x-user-id': 'owner-1' }, payload: {
                attachmentId: '33333333-3333-4333-8333-333333333333',
                name: '../报告.pdf', mimeType: 'image/jpeg', kind: 'image', size: 5, sha256: HELLO_SHA256,
            },
        })).json();
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/assets/${asset.assetId}`,
            headers: { 'x-user-id': 'owner-1', 'content-type': 'application/octet-stream' }, payload: Buffer.from('hello'),
        });
        const unicodeSnapshot = snapshot(asset.assetId);
        const attachmentBlock = unicodeSnapshot.messages[0].blocks[0];
        if ('name' in attachmentBlock && attachmentBlock.type === 'attachment') attachmentBlock.name = '报告.pdf';
        await app.inject({
            method: 'PUT', url: `/v1/sessions/session-1/share/drafts/${draft.generation}/publish`,
            headers: { 'x-user-id': 'owner-1' }, payload: { snapshot: unicodeSnapshot },
        });

        const response = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}/attachments/${asset.assetId}` });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('image/jpeg');
        expect(response.headers['content-disposition']).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        const head = await app.inject({ method: 'HEAD', url: `/v1/public/session-shares/${draft.publicId}/attachments/${asset.assetId}` });
        expect(head.statusCode).toBe(200);
        expect(head.body).toBe('');
        expect((await app.inject({ method: 'GET', url: '/v1/public/session-shares/unknown' })).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: `/v1/public/session-shares/${draft.publicId}/attachments/unknown` })).statusCode).toBe(404);
        const overlong = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${'x'.repeat(2_000)}` });
        expect(overlong.statusCode).toBe(404);
        expect(overlong.json()).toEqual({ error: 'Shared session not found' });
        expect(overlong.headers['cache-control']).toBe('no-store');
    });
});

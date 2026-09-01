import fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

type ShareRow = {
    id: string;
    publicId: string;
    accountId: string | null;
    sessionId: string | null;
    managementTokenHash: Buffer | null;
    createRequestId: string | null;
    sourceProvider: string | null;
    expiresAt: Date | null;
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

const { state, dbMock, storageMock, resetState } = vi.hoisted(() => {
    const state = {
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
        if (Buffer.isBuffer(wanted)) return Buffer.isBuffer(actual) && actual.equals(wanted);
        if (wanted && typeof wanted === 'object' && !Array.isArray(wanted) && !(wanted instanceof Date)) {
            if ('in' in wanted && !wanted.in.includes(actual)) return false;
            if ('gt' in wanted && !(actual > wanted.gt)) return false;
            if ('lte' in wanted && !(actual <= wanted.lte)) return false;
            const operators = new Set(['in', 'gt', 'lte']);
            const nested = Object.fromEntries(Object.entries(wanted).filter(([operator]) => !operators.has(operator)));
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
                accountId: null,
                sessionId: null,
                managementTokenHash: null,
                createRequestId: null,
                sourceProvider: null,
                expiresAt: null,
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
        findMany: vi.fn(async ({ where }: any) => state.drafts.filter((row) => matches(row, where))),
        findFirst: vi.fn(async ({ where }: any) => state.drafts.find((row) => matches(row, where)) ?? null),
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
    };
    const publicSessionShareAsset = {
        findMany: vi.fn(async ({ where }: any) => state.assets.filter((row) => matches(row, where))),
        findFirst: vi.fn(async ({ where }: any) => state.assets.find((row) => matches(row, where)) ?? null),
        create: vi.fn(async ({ data }: any) => {
            const row = { createdAt: new Date(), uploadedAt: null, ...data } as AssetRow;
            state.assets.push(row);
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const rows = state.assets.filter((row) => matches(row, where));
            rows.forEach((row) => applyData(row, data));
            return { count: rows.length };
        }),
    };
    const dbMock: any = {
        session: { findFirst: vi.fn(async () => null) },
        publicSessionShare,
        publicSessionShareDraft,
        publicSessionShareAsset,
    };
    dbMock.$transaction = vi.fn(async (callback: any) => callback(dbMock));

    const storageMock = {
        buildPublicShareStoragePath: vi.fn((shareId: string, generation: string, assetId: string) =>
            `private/session-shares/${shareId}/${generation}/${assetId}`),
        putPublicShareAsset: vi.fn(async (storagePath: string, bytes: Buffer) => { state.bytes.set(storagePath, bytes); }),
        publicShareAssetExists: vi.fn(async (storagePath: string, size: number) => state.bytes.get(storagePath)?.length === size),
        getPublicShareDownloadSource: vi.fn(async (storagePath: string) => {
            const data = state.bytes.get(storagePath);
            if (!data) throw new Error('missing');
            return { kind: 'buffer' as const, data };
        }),
        deletePublicShareGeneration: vi.fn(async () => undefined),
    };

    const resetState = () => {
        state.shares = [];
        state.drafts = [];
        state.assets = [];
        state.bytes.clear();
        state.nextShare = 1;
        vi.clearAllMocks();
    };
    return { state, dbMock, storageMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/sessionSharing/publicSessionShareStorage', () => storageMock);

import { externalSessionShareRoutes } from './externalSessionShareRoutes';
import { publicSessionShareRoutes } from './publicSessionShareRoutes';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const OTHER_TOKEN = Buffer.alloc(32, 8).toString('base64url');
const AUTHORIZATION = `PawsShare ${TOKEN}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const HELLO_SHA256 = createHash('sha256').update('hello').digest('hex');

async function createApp() {
    const app = fastify({ bodyLimit: 12 * 1024 * 1024 });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (_request: any, reply: any) => reply.code(401).send({ error: 'Unauthorized' }));
    externalSessionShareRoutes(typed);
    publicSessionShareRoutes(typed);
    await app.ready();
    return app;
}

function snapshot(attachmentId?: string) {
    return {
        version: 1 as const,
        title: 'Codex drawing review',
        sharedAt: 1_788_192_000_000,
        source: { provider: 'codex' as const },
        presentation: { groupToolCalls: true },
        messages: [{
            id: 'assistant-1',
            role: 'assistant' as const,
            createdAt: 1_788_192_000_000,
            blocks: attachmentId
                ? [{ type: 'attachment' as const, attachmentId, kind: 'file' as const, name: 'drawing.svg', mimeType: 'image/svg+xml', size: 5 }]
                : [{ type: 'text' as const, markdown: 'Drawing complete.' }],
        }],
    };
}

describe('externalSessionShareRoutes', () => {
    let app: Awaited<ReturnType<typeof createApp>>;

    beforeEach(async () => {
        resetState();
        app = await createApp();
    });
    afterEach(async () => app.close());

    async function createDraft(token = TOKEN, requestId = REQUEST_ID) {
        return app.inject({
            method: 'POST',
            url: '/v1/external/session-shares/drafts',
            headers: { authorization: `PawsShare ${token}`, 'idempotency-key': requestId },
            payload: { sourceProvider: 'codex' },
        });
    }

    it('creates one capability-owned draft when an identical request is retried', async () => {
        const first = await createDraft();
        const retry = await createDraft();

        expect(first.statusCode).toBe(200);
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual(first.json());
        expect(state.shares).toHaveLength(1);
        expect(state.drafts).toHaveLength(1);
        expect(state.shares[0]).toMatchObject({ accountId: null, sessionId: null, sourceProvider: 'codex' });
        expect(state.shares[0].managementTokenHash?.toString('hex')).not.toBe(Buffer.from(TOKEN).toString('hex'));
        expect(first.json().expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(first.json())).not.toContain(TOKEN);
    });

    it('hides a managed share from callers with a different capability', async () => {
        const created = (await createDraft()).json();

        const response = await app.inject({
            method: 'GET',
            url: `/v1/external/session-shares/${created.shareId}`,
            headers: { authorization: `PawsShare ${OTHER_TOKEN}` },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Shared session not found' });
    });

    it('publishes an uploaded attachment atomically through the existing public endpoints', async () => {
        const created = (await createDraft()).json();
        const prepared = await app.inject({
            method: 'POST',
            url: `/v1/external/session-shares/${created.shareId}/drafts/${created.generation}/assets`,
            headers: { authorization: AUTHORIZATION },
            payload: {
                attachmentId: ATTACHMENT_ID,
                name: 'drawing.svg',
                mimeType: 'image/svg+xml',
                kind: 'file',
                size: 5,
                sha256: HELLO_SHA256,
            },
        });
        expect(prepared.statusCode).toBe(200);

        const beforeUpload = await app.inject({
            method: 'PUT',
            url: `/v1/external/session-shares/${created.shareId}/drafts/${created.generation}/publish`,
            headers: { authorization: AUTHORIZATION },
            payload: { snapshot: snapshot(ATTACHMENT_ID) },
        });
        expect(beforeUpload.statusCode).toBe(409);

        const upload = await app.inject({
            method: 'PUT',
            url: prepared.json().uploadUrl,
            headers: { authorization: AUTHORIZATION, 'content-type': 'application/octet-stream' },
            payload: Buffer.from('hello'),
        });
        expect(upload.statusCode).toBe(200);

        const publish = await app.inject({
            method: 'PUT',
            url: `/v1/external/session-shares/${created.shareId}/drafts/${created.generation}/publish`,
            headers: { authorization: AUTHORIZATION },
            payload: { snapshot: snapshot(ATTACHMENT_ID) },
        });
        expect(publish.statusCode).toBe(200);

        const publicSnapshot = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${created.publicId}` });
        expect(publicSnapshot.statusCode).toBe(200);
        expect(publicSnapshot.json().snapshot.source).toEqual({ provider: 'codex' });

        const publicAttachment = await app.inject({
            method: 'GET',
            url: `/v1/public/session-shares/${created.publicId}/attachments/${ATTACHMENT_ID}`,
        });
        expect(publicAttachment.statusCode).toBe(200);
        expect(publicAttachment.rawPayload.toString()).toBe('hello');
        expect(publicAttachment.headers['content-type']).toContain('application/octet-stream');
    });

    it('renews and then revokes a share idempotently using only the local capability', async () => {
        const created = (await createDraft()).json();
        const originalExpiry = state.shares[0].expiresAt!.getTime();

        const renew = await app.inject({
            method: 'POST',
            url: `/v1/external/session-shares/${created.shareId}/renew`,
            headers: { authorization: AUTHORIZATION },
        });
        expect(renew.statusCode).toBe(200);
        expect(new Date(renew.json().expiresAt).getTime()).toBeGreaterThan(originalExpiry);

        const firstRevoke = await app.inject({
            method: 'DELETE',
            url: `/v1/external/session-shares/${created.shareId}`,
            headers: { authorization: AUTHORIZATION },
        });
        const retryRevoke = await app.inject({
            method: 'DELETE',
            url: `/v1/external/session-shares/${created.shareId}`,
            headers: { authorization: AUTHORIZATION },
        });
        expect(firstRevoke.statusCode).toBe(200);
        expect(retryRevoke.statusCode).toBe(200);
        expect(state.shares[0].revokedAt).toBeInstanceOf(Date);
    });

    it('returns the generic public not-found response after expiry', async () => {
        const created = (await createDraft()).json();
        state.shares[0].expiresAt = new Date(Date.now() - 1);
        state.shares[0].snapshot = snapshot();
        state.shares[0].publishedAt = new Date();
        state.shares[0].activeGeneration = created.generation;

        const response = await app.inject({ method: 'GET', url: `/v1/public/session-shares/${created.publicId}` });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Shared session not found' });
    });
});

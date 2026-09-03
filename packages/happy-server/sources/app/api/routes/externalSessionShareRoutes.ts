import * as crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import {
    publicSessionSnapshotSchema,
    publicSessionSourceProviderSchema,
    publicShareAssetKindSchema,
} from '@/app/sessionSharing/publicSessionShareSchemas';
import {
    capabilityExpiry,
    hashShareManagementToken,
    isValidShareOwnership,
    readShareCapabilityAuthorization,
    verifyShareManagementToken,
} from '@/app/sessionSharing/publicSessionShareCapability';
import {
    buildPublicShareStoragePath,
    deletePublicShareGeneration,
    publicShareAssetExists,
    putPublicShareAsset,
    readPublicShareAssetBytes,
} from '@/app/sessionSharing/publicSessionShareStorage';
import { createPublicShareRateLimiter } from '@/app/sessionSharing/publicSessionShareRateLimit';
import { cleanupPublicSessionShareGeneration } from '@/app/sessionSharing/publicSessionShareCleanup';
import {
    collectPublicSessionShareAssetManifest,
    manifestMetadataMatches,
    PublicSessionCoverValidationError,
    validateUploadedPublicSessionCover,
} from '@/app/sessionSharing/publicSessionShareAssetValidation';
import { publicSessionUserAssetNameSchema } from '@/app/sessionSharing/publicSessionShareAssetNames';

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_COUNT = 50;
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_ASSET_SIZE = 200 * 1024 * 1024;
const MAX_RETAINED_DRAFTS = 4;
const DRAFT_TTL_MS = 60 * 60 * 1000;
const SMALL_JSON_BODY_LIMIT = 8 * 1024;
const SNAPSHOT_BODY_LIMIT = MAX_SNAPSHOT_BYTES + 64 * 1024;
const createRate = createPublicShareRateLimiter({ scope: 'external-create', max: 30, windowMs: 60_000 });
const writeIpRate = createPublicShareRateLimiter({ scope: 'external-write-ip', max: 240, windowMs: 60_000 });
const writeCapabilityRate = createPublicShareRateLimiter({ scope: 'external-write-capability', max: 600, windowMs: 60_000 });

const shareParamsSchema = z.object({ shareId: z.string().min(1).max(200) });
const draftParamsSchema = shareParamsSchema.extend({ generation: z.string().uuid() });
const assetParamsSchema = draftParamsSchema.extend({ assetId: z.string().uuid() });
const createBodySchema = z.object({
    sourceProvider: publicSessionSourceProviderSchema,
}).strict();
const prepareAssetBodySchema = z.object({
    attachmentId: z.string().uuid(),
    name: publicSessionUserAssetNameSchema,
    mimeType: z.string().min(1).max(200),
    kind: publicShareAssetKindSchema,
    size: z.number().int().min(0).max(MAX_ASSET_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type ManagedShare = NonNullable<Awaited<ReturnType<typeof db.publicSessionShare.findUnique>>>;
type ManagedAvailability = 'any' | 'renewable' | 'writable';

const requestShares = new WeakMap<object, ManagedShare>();

class ExternalShareRequestError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message);
    }
}

function newPublicId(): string {
    return `ps_${crypto.randomBytes(32).toString('base64url')}`;
}

function draftExpiry(): Date {
    return new Date(Date.now() + DRAFT_TTL_MS);
}

function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
    const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? 'http';
    return typeof host === 'string' && host ? `${protocol}://${host}` : `http://localhost:${process.env.PORT || '3005'}`;
}

function managedNotFound(reply: any) {
    return reply.code(404).send({ error: 'Shared session not found' });
}

async function enforceRate(
    limiter: ReturnType<typeof createPublicShareRateLimiter>,
    key: string,
    reply: any,
): Promise<boolean> {
    const result = await limiter.check(key);
    if (result.allowed) return true;
    reply.header('Retry-After', result.retryAfterSeconds);
    reply.code(429).send({ error: 'Too many share requests. Try again in a minute.' });
    return false;
}

async function managedShare(shareId: string, authorization: unknown): Promise<ManagedShare | null> {
    const token = readShareCapabilityAuthorization(authorization);
    if (!token) return null;
    const share = await db.publicSessionShare.findUnique({ where: { id: shareId } });
    if (!share?.managementTokenHash || !verifyShareManagementToken(token, share.managementTokenHash)) return null;
    return share;
}

function availableForWrite(share: ManagedShare): boolean {
    return !share.revokedAt && Boolean(share.expiresAt && share.expiresAt > new Date());
}

function managedShareOnRequest(availability: ManagedAvailability = 'writable') {
    return async (request: any, reply: any) => {
        if (!await enforceRate(writeIpRate, request.ip, reply)) return;
        const shareId = typeof request.params?.shareId === 'string' ? request.params.shareId : '';
        const share = await managedShare(shareId, request.headers.authorization);
        const unavailable = !share
            || (availability === 'writable' && !availableForWrite(share))
            || (availability === 'renewable' && Boolean(share.revokedAt));
        if (unavailable) return managedNotFound(reply);
        if (!await enforceRate(writeCapabilityRate, share.id, reply)) return;
        requestShares.set(request, share);
    };
}

function preauthenticatedShare(request: object): ManagedShare {
    const share = requestShares.get(request);
    if (!share) throw new Error('Managed share authentication hook did not run');
    return share;
}

async function createDraftOnRequest(request: any, reply: any) {
    if (!await enforceRate(createRate, request.ip, reply)) return;
    const token = readShareCapabilityAuthorization(request.headers.authorization);
    const requestId = request.headers['idempotency-key'];
    if (!token || typeof requestId !== 'string' || !z.string().uuid().safeParse(requestId).success) {
        return reply.code(400).send({ error: 'Valid capability and Idempotency-Key are required' });
    }
}

function sameSnapshot(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function serializableTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await db.$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
            if ((error as { code?: string })?.code !== 'P2034' || attempt === 2) throw error;
        }
    }
    throw new Error('Serializable transaction retry exhausted');
}

async function createDraftForShare(share: ManagedShare): Promise<string> {
    const generation = crypto.randomUUID();
    const nextLifecycleVersion = share.lifecycleVersion + 1;
    await serializableTransaction(async (tx) => {
        const retainedDrafts = await tx.publicSessionShareDraft.findMany({
            where: { shareId: share.id, status: { in: ['pending', 'superseded'] } },
        });
        if (retainedDrafts.length >= MAX_RETAINED_DRAFTS) {
            throw new ExternalShareRequestError(413, 'Shared-session retained draft limit exceeded');
        }
        const previousDrafts = retainedDrafts.filter((draft) => draft.status === 'pending');
        const changed = await tx.publicSessionShare.updateMany({
            where: { id: share.id, lifecycleVersion: share.lifecycleVersion, revokedAt: null },
            data: { lifecycleVersion: { increment: 1 } },
        });
        if (changed.count !== 1) throw new ExternalShareRequestError(409, 'Shared-session state changed; retry');
        if (previousDrafts.length > 0) {
            await tx.publicSessionShareDraft.updateMany({
                where: { id: { in: previousDrafts.map((draft) => draft.id) }, shareId: share.id },
                data: { status: 'superseded', expiresAt: new Date() },
            });
        }
        await tx.publicSessionShareDraft.create({
            data: {
                id: generation,
                shareId: share.id,
                lifecycleVersion: nextLifecycleVersion,
                status: 'pending',
                expiresAt: draftExpiry(),
            },
        });
    });
    return generation;
}

export function externalSessionShareRoutes(app: Fastify) {
    app.post('/v1/external/session-shares/drafts', {
        onRequest: createDraftOnRequest,
        bodyLimit: SMALL_JSON_BODY_LIMIT,
        schema: { body: createBodySchema },
    }, async (request, reply) => {
        const token = readShareCapabilityAuthorization(request.headers.authorization);
        const requestId = request.headers['idempotency-key'];
        if (!token || typeof requestId !== 'string') throw new Error('External share create hook did not validate capability');
        const tokenHash = hashShareManagementToken(token);
        const existing = await db.publicSessionShare.findUnique({ where: { createRequestId: requestId } });
        if (existing) {
            if (!existing.managementTokenHash || !verifyShareManagementToken(token, existing.managementTokenHash)) {
                return managedNotFound(reply);
            }
            const draft = await db.publicSessionShareDraft.findFirst({
                where: { shareId: existing.id, status: 'pending' },
            });
            if (!draft) return reply.code(409).send({ error: 'Idempotent draft is no longer available' });
            return reply.send({
                shareId: existing.id,
                generation: draft.id,
                publicId: existing.publicId,
                publicUrl: `${resolveBaseUrl(request)}/share/${existing.publicId}`,
                expiresAt: existing.expiresAt!.toISOString(),
            });
        }

        const generation = crypto.randomUUID();
        const expiresAt = capabilityExpiry();
        const ownership = { accountId: null, sessionId: null, managementTokenHash: Uint8Array.from(tokenHash) };
        if (!isValidShareOwnership(ownership)) throw new Error('Invalid public share ownership');
        const created = await serializableTransaction(async (tx) => {
            const share = await tx.publicSessionShare.create({
                data: {
                    publicId: newPublicId(),
                    accountId: null,
                    sessionId: null,
                    managementTokenHash: ownership.managementTokenHash,
                    createRequestId: requestId,
                    sourceProvider: request.body.sourceProvider,
                    expiresAt,
                },
            });
            await tx.publicSessionShareDraft.create({
                data: {
                    id: generation,
                    shareId: share.id,
                    lifecycleVersion: share.lifecycleVersion,
                    status: 'pending',
                    expiresAt: draftExpiry(),
                },
            });
            return share;
        });
        return reply.send({
            shareId: created.id,
            generation,
            publicId: created.publicId,
            publicUrl: `${resolveBaseUrl(request)}/share/${created.publicId}`,
            expiresAt: expiresAt.toISOString(),
        });
    });

    app.get('/v1/external/session-shares/:shareId', {
        onRequest: managedShareOnRequest('any'),
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        return reply.send({
            shareId: share.id,
            publicId: share.publicId,
            active: Boolean(share.publishedAt && !share.revokedAt && share.expiresAt && share.expiresAt > new Date()),
            revoked: Boolean(share.revokedAt),
            publishedAt: share.publishedAt?.toISOString() ?? null,
            expiresAt: share.expiresAt?.toISOString() ?? null,
            sourceProvider: share.sourceProvider,
        });
    });

    app.post('/v1/external/session-shares/:shareId/drafts', {
        onRequest: managedShareOnRequest(),
        bodyLimit: 1,
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        try {
            const generation = await createDraftForShare(share);
            // Superseded pending drafts remain as durable tombstones until the
            // cleanup grace window passes. An upload authorized just before
            // replacement can then either remove its own late object or leave
            // a row that the scheduled cleanup worker can retry safely.
            return reply.send({ generation, publicId: share.publicId });
        } catch (error) {
            if (error instanceof ExternalShareRequestError) return reply.code(error.statusCode).send({ error: error.message });
            throw error;
        }
    });

    app.post('/v1/external/session-shares/:shareId/drafts/:generation/assets', {
        onRequest: managedShareOnRequest(),
        bodyLimit: SMALL_JSON_BODY_LIMIT,
        schema: { params: draftParamsSchema, body: prepareAssetBodySchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        let draft: { id: string };
        try {
            draft = await serializableTransaction(async (tx) => {
                const currentShare = await tx.publicSessionShare.findFirst({
                    where: {
                        id: share.id,
                        lifecycleVersion: share.lifecycleVersion,
                        revokedAt: null,
                        expiresAt: { gt: new Date() },
                    },
                });
                if (!currentShare) throw new ExternalShareRequestError(409, 'Shared-session draft is unavailable');
                const currentDraft = await tx.publicSessionShareDraft.findFirst({
                    where: {
                        id: request.params.generation,
                        shareId: share.id,
                        lifecycleVersion: share.lifecycleVersion,
                        status: 'pending',
                        expiresAt: { gt: new Date() },
                    },
                });
                if (!currentDraft) throw new ExternalShareRequestError(409, 'Shared-session draft is unavailable');
                const retainedAssets = await tx.publicSessionShareAsset.findMany({
                    where: {
                        shareId: share.id,
                        draft: { status: { in: ['pending', 'superseded'] } },
                    },
                });
                const assets = retainedAssets.filter((asset) => asset.generation === currentDraft.id);
                const existing = assets.find((asset) => asset.id === request.body.attachmentId);
                const name = request.body.name;
                if (existing) {
                    const identical = existing.name === name
                        && existing.mimeType === request.body.mimeType
                        && existing.kind === request.body.kind
                        && existing.size === request.body.size
                        && existing.sha256 === request.body.sha256;
                    if (!identical) throw new ExternalShareRequestError(409, 'Shared attachment already exists');
                } else {
                    const retainedSize = retainedAssets.reduce((sum, asset) => sum + asset.size, 0) + request.body.size;
                    if (retainedAssets.length >= MAX_ASSET_COUNT || retainedSize > MAX_TOTAL_ASSET_SIZE) {
                        throw new ExternalShareRequestError(413, 'Shared session attachment limit exceeded');
                    }
                    await tx.publicSessionShareAsset.create({
                        data: {
                            id: request.body.attachmentId,
                            shareId: share.id,
                            generation: currentDraft.id,
                            name,
                            mimeType: request.body.mimeType,
                            kind: request.body.kind,
                            size: request.body.size,
                            sha256: request.body.sha256,
                            storagePath: buildPublicShareStoragePath(share.id, currentDraft.id, request.body.attachmentId),
                        },
                    });
                }
                return currentDraft;
            });
        } catch (error) {
            if (error instanceof ExternalShareRequestError) return reply.code(error.statusCode).send({ error: error.message });
            throw error;
        }
        return reply.send({
            assetId: request.body.attachmentId,
            method: 'PUT',
            uploadUrl: `${resolveBaseUrl(request)}/v1/external/session-shares/${share.id}/drafts/${draft.id}/assets/${request.body.attachmentId}`,
        });
    });

    app.put('/v1/external/session-shares/:shareId/drafts/:generation/assets/:assetId', {
        onRequest: managedShareOnRequest(),
        bodyLimit: MAX_ASSET_SIZE,
        schema: { params: assetParamsSchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        const draft = await db.publicSessionShareDraft.findFirst({
            where: {
                id: request.params.generation,
                shareId: share.id,
                lifecycleVersion: share.lifecycleVersion,
                status: 'pending',
                expiresAt: { gt: new Date() },
            },
        });
        if (!draft) return reply.code(409).send({ error: 'Shared-session draft is unavailable' });
        const asset = await db.publicSessionShareAsset.findFirst({
            where: { id: request.params.assetId, shareId: share.id, generation: draft.id },
        });
        if (!asset) return reply.code(404).send({ error: 'Shared attachment not found' });
        if (asset.uploadedAt) return reply.send({ ok: true });
        const body = request.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length !== asset.size) {
            return reply.code(400).send({ error: 'Shared attachment size mismatch' });
        }
        if (crypto.createHash('sha256').update(body).digest('hex') !== asset.sha256) {
            return reply.code(400).send({ error: 'Shared attachment checksum mismatch' });
        }
        await putPublicShareAsset(asset.storagePath, body);
        const stillPending = await db.publicSessionShareDraft.findFirst({
            where: {
                id: draft.id,
                shareId: share.id,
                lifecycleVersion: share.lifecycleVersion,
                status: 'pending',
                expiresAt: { gt: new Date() },
                share: { revokedAt: null, lifecycleVersion: share.lifecycleVersion },
            },
        });
        if (!stillPending) {
            await deletePublicShareGeneration(share.id, draft.id).catch(() => undefined);
            return reply.code(409).send({ error: 'Shared-session draft is unavailable' });
        }
        const marked = await db.publicSessionShareAsset.updateMany({
            where: { id: asset.id, shareId: share.id, generation: draft.id, uploadedAt: null },
            data: { uploadedAt: new Date() },
        });
        if (marked.count !== 1) return reply.code(409).send({ error: 'Shared attachment is immutable' });
        return reply.send({ ok: true });
    });

    app.put('/v1/external/session-shares/:shareId/drafts/:generation/publish', {
        onRequest: managedShareOnRequest(),
        bodyLimit: SNAPSHOT_BODY_LIMIT,
        schema: {
            params: draftParamsSchema,
            body: z.object({ snapshot: publicSessionSnapshotSchema }).strict(),
        },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        if (Buffer.byteLength(JSON.stringify(request.body.snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
            return reply.code(413).send({ error: 'Shared session snapshot limit exceeded' });
        }
        if (request.body.snapshot.source?.provider !== share.sourceProvider) {
            return reply.code(409).send({ error: 'Shared session source does not match' });
        }
        const existingDraft = await db.publicSessionShareDraft.findFirst({
            where: { id: request.params.generation, shareId: share.id },
        });
        if (existingDraft?.status === 'published'
            && share.activeGeneration === existingDraft.id
            && sameSnapshot(share.snapshot, request.body.snapshot)) {
            return reply.send({ publicId: share.publicId, publishedAt: share.publishedAt!.getTime() });
        }
        const draft = await db.publicSessionShareDraft.findFirst({
            where: {
                id: request.params.generation,
                shareId: share.id,
                lifecycleVersion: share.lifecycleVersion,
                status: 'pending',
                expiresAt: { gt: new Date() },
            },
        });
        if (!draft) return reply.code(409).send({ error: 'Shared-session draft is unavailable' });
        const assets = await db.publicSessionShareAsset.findMany({
            where: { shareId: share.id, generation: draft.id },
        });
        const manifest = collectPublicSessionShareAssetManifest(request.body.snapshot);
        const referencedIds = new Set(manifest.map((asset) => asset.assetId));
        if (assets.length !== referencedIds.size || assets.some((asset) => !referencedIds.has(asset.id))) {
            return reply.code(409).send({ error: 'Shared attachment manifest mismatch' });
        }
        const assetById = new Map(assets.map((asset) => [asset.id, asset]));
        for (const descriptor of manifest) {
            const asset = assetById.get(descriptor.assetId);
            if (!asset || !manifestMetadataMatches(descriptor, asset)) {
                return reply.code(409).send({ error: 'Shared attachment metadata mismatch' });
            }
        }
        for (const asset of assets) {
            if (!asset.uploadedAt || !await publicShareAssetExists(asset.storagePath, asset.size)) {
                return reply.code(409).send({ error: 'Shared attachment upload incomplete' });
            }
        }
        const cover = request.body.snapshot.version === 2
            ? request.body.snapshot.appearance.cover
            : undefined;
        if (cover) {
            const asset = assetById.get(cover.assetId);
            if (!asset || cover.attribution) {
                return reply.code(409).send({ error: 'Shared attachment metadata mismatch' });
            }
            try {
                await validateUploadedPublicSessionCover({
                    cover,
                    asset,
                    readBytes: readPublicShareAssetBytes,
                });
            } catch (error) {
                if (error instanceof PublicSessionCoverValidationError) {
                    return reply.code(409).send({ error: error.message });
                }
                throw error;
            }
        }
        const oldGeneration = share.activeGeneration;
        const publishedAt = new Date();
        const changed = await serializableTransaction(async (tx) => {
            const update = await tx.publicSessionShare.updateMany({
                where: { id: share.id, lifecycleVersion: draft.lifecycleVersion, revokedAt: null },
                data: {
                    snapshot: request.body.snapshot as Prisma.InputJsonValue,
                    activeGeneration: draft.id,
                    publishedAt,
                    lifecycleVersion: { increment: 1 },
                },
            });
            if (update.count !== 1) throw new ExternalShareRequestError(409, 'Shared-session draft is stale');
            if (oldGeneration && oldGeneration !== draft.id) {
                await tx.publicSessionShareDraft.updateMany({
                    where: { id: oldGeneration, shareId: share.id },
                    data: { status: 'superseded', expiresAt: publishedAt },
                });
            }
            const finalized = await tx.publicSessionShareDraft.updateMany({
                where: {
                    id: draft.id,
                    shareId: share.id,
                    lifecycleVersion: draft.lifecycleVersion,
                    status: 'pending',
                    expiresAt: { gt: publishedAt },
                },
                data: { status: 'published' },
            });
            if (finalized.count !== 1) throw new ExternalShareRequestError(409, 'Shared-session draft is stale');
            return true;
        }).catch((error) => {
            if (error instanceof ExternalShareRequestError) return false;
            throw error;
        });
        if (!changed) return reply.code(409).send({ error: 'Shared-session draft is stale' });
        if (oldGeneration && oldGeneration !== draft.id) {
            await cleanupPublicSessionShareGeneration(share.id, oldGeneration).catch(() => undefined);
        }
        return reply.send({ publicId: share.publicId, publishedAt: publishedAt.getTime() });
    });

    app.post('/v1/external/session-shares/:shareId/renew', {
        onRequest: managedShareOnRequest('renewable'),
        bodyLimit: 1,
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        const now = new Date();
        const expiresAt = capabilityExpiry(share.expiresAt && share.expiresAt > now ? share.expiresAt : now);
        const renewed = await db.publicSessionShare.updateMany({
            where: { id: share.id, revokedAt: null, expiresAt: share.expiresAt },
            data: { expiresAt },
        });
        if (renewed.count !== 1) return managedNotFound(reply);
        return reply.send({ expiresAt: expiresAt.toISOString() });
    });

    app.delete('/v1/external/session-shares/:shareId', {
        onRequest: managedShareOnRequest('any'),
        bodyLimit: 1,
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = preauthenticatedShare(request);
        if (share.revokedAt) return reply.send({ ok: true });
        const revokedAt = new Date();
        const drafts = await db.publicSessionShareDraft.findMany({ where: { shareId: share.id } });
        await serializableTransaction(async (tx) => {
            await tx.publicSessionShare.updateMany({
                where: { id: share.id, revokedAt: null },
                data: { revokedAt, lifecycleVersion: { increment: 1 } },
            });
            await tx.publicSessionShareDraft.updateMany({
                where: { shareId: share.id },
                data: { status: 'revoked', expiresAt: revokedAt },
            });
        });
        const generations = new Set(drafts.map((draft) => draft.id));
        if (share.activeGeneration) generations.add(share.activeGeneration);
        await Promise.all(Array.from(generations, (generation) => deletePublicShareGeneration(share.id, generation).catch(() => undefined)));
        return reply.send({ ok: true });
    });
}

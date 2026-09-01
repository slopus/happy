import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import {
    publicSessionSnapshotSchema,
    publicSessionSourceProviderSchema,
    publicShareAssetKindSchema,
    type PublicSessionSnapshot,
} from '@/app/sessionSharing/publicSessionShareSchemas';
import {
    capabilityExpiry,
    hashShareManagementToken,
    readShareCapabilityAuthorization,
    verifyShareManagementToken,
} from '@/app/sessionSharing/publicSessionShareCapability';
import {
    buildPublicShareStoragePath,
    deletePublicShareGeneration,
    publicShareAssetExists,
    putPublicShareAsset,
} from '@/app/sessionSharing/publicSessionShareStorage';
import { createPublicShareRateLimiter } from '@/app/sessionSharing/publicSessionShareRateLimit';

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_COUNT = 50;
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_ASSET_SIZE = 200 * 1024 * 1024;
const DRAFT_TTL_MS = 60 * 60 * 1000;
const createRate = createPublicShareRateLimiter({ scope: 'external-create', max: 30, windowMs: 60_000 });
const writeRate = createPublicShareRateLimiter({ scope: 'external-write', max: 600, windowMs: 60_000 });

const shareParamsSchema = z.object({ shareId: z.string().min(1).max(200) });
const draftParamsSchema = shareParamsSchema.extend({ generation: z.string().uuid() });
const assetParamsSchema = draftParamsSchema.extend({ assetId: z.string().uuid() });
const createBodySchema = z.object({
    sourceProvider: publicSessionSourceProviderSchema,
}).strict();
const prepareAssetBodySchema = z.object({
    attachmentId: z.string().uuid(),
    name: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(200),
    kind: publicShareAssetKindSchema,
    size: z.number().int().min(0).max(MAX_ASSET_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type ManagedShare = NonNullable<Awaited<ReturnType<typeof db.publicSessionShare.findUnique>>>;

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

function safeName(name: string): string {
    const base = path.basename(name).replace(/[\u0000-\u001f\u007f"\\]/g, '_');
    return base || 'attachment';
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

function attachmentIds(snapshot: PublicSessionSnapshot): Set<string> {
    const ids = new Set<string>();
    for (const message of snapshot.messages) {
        for (const block of message.blocks) {
            if (block.type === 'attachment') ids.add(block.attachmentId);
        }
    }
    return ids;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function createDraftForShare(share: ManagedShare): Promise<string> {
    const generation = crypto.randomUUID();
    await db.$transaction(async (tx) => {
        const previousDrafts = await tx.publicSessionShareDraft.findMany({
            where: { shareId: share.id, status: 'pending' },
        });
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
                lifecycleVersion: share.lifecycleVersion + 1,
                status: 'pending',
                expiresAt: draftExpiry(),
            },
        });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return generation;
}

export function externalSessionShareRoutes(app: Fastify) {
    app.post('/v1/external/session-shares/drafts', {
        schema: { body: createBodySchema },
    }, async (request, reply) => {
        if (!await enforceRate(createRate, request.ip, reply)) return;
        const token = readShareCapabilityAuthorization(request.headers.authorization);
        const requestId = request.headers['idempotency-key'];
        if (!token || typeof requestId !== 'string' || !z.string().uuid().safeParse(requestId).success) {
            return reply.code(400).send({ error: 'Valid capability and Idempotency-Key are required' });
        }
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
        const created = await db.$transaction(async (tx) => {
            const share = await tx.publicSessionShare.create({
                data: {
                    publicId: newPublicId(),
                    accountId: null,
                    sessionId: null,
                    managementTokenHash: Uint8Array.from(tokenHash),
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
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return reply.send({
            shareId: created.id,
            generation,
            publicId: created.publicId,
            publicUrl: `${resolveBaseUrl(request)}/share/${created.publicId}`,
            expiresAt: expiresAt.toISOString(),
        });
    });

    app.get('/v1/external/session-shares/:shareId', {
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share) return managedNotFound(reply);
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
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share || !availableForWrite(share)) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
        try {
            const generation = await createDraftForShare(share);
            return reply.send({ generation, publicId: share.publicId });
        } catch (error) {
            if (error instanceof ExternalShareRequestError) return reply.code(error.statusCode).send({ error: error.message });
            throw error;
        }
    });

    app.post('/v1/external/session-shares/:shareId/drafts/:generation/assets', {
        schema: { params: draftParamsSchema, body: prepareAssetBodySchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share || !availableForWrite(share)) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
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
        const existing = assets.find((asset) => asset.id === request.body.attachmentId);
        const name = safeName(request.body.name);
        if (existing) {
            const identical = existing.name === name
                && existing.mimeType === request.body.mimeType
                && existing.kind === request.body.kind
                && existing.size === request.body.size
                && existing.sha256 === request.body.sha256;
            if (!identical) return reply.code(409).send({ error: 'Shared attachment already exists' });
        } else {
            const totalSize = assets.reduce((sum, asset) => sum + asset.size, 0) + request.body.size;
            if (assets.length >= MAX_ASSET_COUNT || totalSize > MAX_TOTAL_ASSET_SIZE) {
                return reply.code(413).send({ error: 'Shared session attachment limit exceeded' });
            }
            await db.publicSessionShareAsset.create({
                data: {
                    id: request.body.attachmentId,
                    shareId: share.id,
                    generation: draft.id,
                    name,
                    mimeType: request.body.mimeType,
                    kind: request.body.kind,
                    size: request.body.size,
                    sha256: request.body.sha256,
                    storagePath: buildPublicShareStoragePath(share.id, draft.id, request.body.attachmentId),
                },
            });
        }
        return reply.send({
            assetId: request.body.attachmentId,
            method: 'PUT',
            uploadUrl: `${resolveBaseUrl(request)}/v1/external/session-shares/${share.id}/drafts/${draft.id}/assets/${request.body.attachmentId}`,
        });
    });

    app.put('/v1/external/session-shares/:shareId/drafts/:generation/assets/:assetId', {
        schema: { params: assetParamsSchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share || !availableForWrite(share)) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
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
        const marked = await db.publicSessionShareAsset.updateMany({
            where: { id: asset.id, shareId: share.id, generation: draft.id, uploadedAt: null },
            data: { uploadedAt: new Date() },
        });
        if (marked.count !== 1) return reply.code(409).send({ error: 'Shared attachment is immutable' });
        return reply.send({ ok: true });
    });

    app.put('/v1/external/session-shares/:shareId/drafts/:generation/publish', {
        schema: {
            params: draftParamsSchema,
            body: z.object({ snapshot: publicSessionSnapshotSchema }).strict(),
        },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share || !availableForWrite(share)) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
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
        const referencedIds = attachmentIds(request.body.snapshot);
        if (assets.length !== referencedIds.size || assets.some((asset) => !referencedIds.has(asset.id))) {
            return reply.code(409).send({ error: 'Shared attachment manifest mismatch' });
        }
        const assetById = new Map(assets.map((asset) => [asset.id, asset]));
        for (const message of request.body.snapshot.messages) {
            for (const block of message.blocks) {
                if (block.type !== 'attachment') continue;
                const asset = assetById.get(block.attachmentId);
                if (!asset
                    || asset.name !== block.name
                    || asset.mimeType !== block.mimeType
                    || asset.kind !== block.kind
                    || asset.size !== block.size) {
                    return reply.code(409).send({ error: 'Shared attachment metadata mismatch' });
                }
            }
        }
        for (const asset of assets) {
            if (!asset.uploadedAt || !await publicShareAssetExists(asset.storagePath, asset.size)) {
                return reply.code(409).send({ error: 'Shared attachment upload incomplete' });
            }
        }
        const publishedAt = new Date();
        const changed = await db.$transaction(async (tx) => {
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
            const finalized = await tx.publicSessionShareDraft.updateMany({
                where: { id: draft.id, shareId: share.id, status: 'pending' },
                data: { status: 'published' },
            });
            if (finalized.count !== 1) throw new ExternalShareRequestError(409, 'Shared-session draft is stale');
            return true;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error) => {
            if (error instanceof ExternalShareRequestError) return false;
            throw error;
        });
        if (!changed) return reply.code(409).send({ error: 'Shared-session draft is stale' });
        return reply.send({ publicId: share.publicId, publishedAt: publishedAt.getTime() });
    });

    app.post('/v1/external/session-shares/:shareId/renew', {
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share || share.revokedAt) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
        const expiresAt = capabilityExpiry();
        await db.publicSessionShare.update({ where: { id: share.id }, data: { expiresAt } });
        return reply.send({ expiresAt: expiresAt.toISOString() });
    });

    app.delete('/v1/external/session-shares/:shareId', {
        schema: { params: shareParamsSchema },
    }, async (request, reply) => {
        const share = await managedShare(request.params.shareId, request.headers.authorization);
        if (!share) return managedNotFound(reply);
        if (!await enforceRate(writeRate, share.id, reply)) return;
        if (share.revokedAt) return reply.send({ ok: true });
        const revokedAt = new Date();
        const drafts = await db.publicSessionShareDraft.findMany({ where: { shareId: share.id } });
        await db.$transaction(async (tx) => {
            await tx.publicSessionShare.updateMany({
                where: { id: share.id, revokedAt: null },
                data: { revokedAt, lifecycleVersion: { increment: 1 } },
            });
            await tx.publicSessionShareDraft.updateMany({
                where: { shareId: share.id },
                data: { status: 'revoked', expiresAt: revokedAt },
            });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        const generations = new Set(drafts.map((draft) => draft.id));
        if (share.activeGeneration) generations.add(share.activeGeneration);
        await Promise.all(Array.from(generations, (generation) => deletePublicShareGeneration(share.id, generation).catch(() => undefined)));
        return reply.send({ ok: true });
    });
}

/**
 * Account-owned encrypted project catalog and avatar transport.
 *
 * Project metadata, data keys, preview material, and avatar bytes are all
 * client-encrypted. The server only indexes the caller-owned external id and
 * stores/serves opaque values.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as privacyKit from 'privacy-kit';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import {
    s3client,
    s3bucket,
    isLocalStorage,
    getLocalFilesDir,
    putLocalFile,
    deleteProjectAvatars,
} from '@/storage/files';
import {
    eventRouter,
    buildNewProjectUpdate,
    buildUpdateProjectUpdate,
    buildDeleteProjectUpdate,
    buildUpdateSessionUpdate,
} from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { inTx, afterTx } from '@/storage/inTx';

const MAX_METADATA_SIZE = 4 * 1024 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const PRESIGNED_TTL_SECONDS = 15 * 60;
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;

const uploadRateState = new Map<string, { count: number; windowStart: number }>();
type StoredBytes = ReturnType<typeof privacyKit.decodeBase64>;

const projectIdParams = z.object({ projectId: z.string().min(1) });
const projectCreateBody = z.object({
    externalId: z.string().min(1).max(512),
    metadata: z.string().min(1).max(MAX_METADATA_SIZE),
    dataEncryptionKey: z.string().nullish(),
});

const projectPatchBody = z.object({
    metadata: z.string().min(1).max(MAX_METADATA_SIZE).optional(),
    expectedMetadataVersion: z.number().int().min(0).optional(),
}).strict();

const avatarActivateBody = z.object({
    ref: z.string().min(1).max(1024),
    preview: z.string().min(1).max(MAX_METADATA_SIZE),
});

const uploadRequestBody = z.object({
    size: z.number().int().min(0).max(MAX_FILE_SIZE),
});

type ProjectRecord = {
    id: string;
    externalId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    dataEncryptionKey: StoredBytes | null;
    avatarRef: string | null;
    avatarPreview: string | null;
    avatarVersion: number;
    createdAt: Date;
    updatedAt: Date;
};

function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? 'http';
    if (typeof host === 'string' && host.length > 0) return `${proto}://${host}`;
    return `http://localhost:${process.env.PORT || '3005'}`;
}

function serializeProject(project: ProjectRecord) {
    return {
        id: project.id,
        externalId: project.externalId,
        metadata: project.metadata,
        metadataVersion: project.metadataVersion,
        dataEncryptionKey: project.dataEncryptionKey ? privacyKit.encodeBase64(project.dataEncryptionKey) : null,
        avatar: project.avatarRef ? {
            ref: project.avatarRef,
            preview: project.avatarPreview || '',
            version: project.avatarVersion,
        } : null,
        seq: project.seq,
        createdAt: project.createdAt.getTime(),
        updatedAt: project.updatedAt.getTime(),
    };
}

function decodeDataKey(value: string | null | undefined): StoredBytes | null | undefined {
    if (value === undefined) return undefined;
    return value === null ? null : privacyKit.decodeBase64(value);
}

function checkUploadRate(userId: string): boolean {
    const now = Date.now();
    const current = uploadRateState.get(userId);
    if (!current || now - current.windowStart >= UPLOAD_RATE_WINDOW_MS) {
        uploadRateState.set(userId, { count: 1, windowStart: now });
        return true;
    }
    if (current.count >= UPLOAD_RATE_MAX) return false;
    current.count += 1;
    return true;
}

function projectAvatarRef(projectId: string, ref: string): boolean {
    const prefix = `projects/${projectId}/avatar/`;
    if (!ref.startsWith(prefix)) return false;
    const filename = ref.slice(prefix.length);
    // The upload endpoint creates UUID v4 names. Do not allow callers to
    // activate arbitrary objects from the project prefix.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/i.test(filename);
}

function localProjectAvatarPath(projectId: string, ref: string): string | null {
    if (!projectAvatarRef(projectId, ref)) return null;
    const baseDir = path.resolve(getLocalFilesDir());
    const fullPath = path.resolve(baseDir, ref);
    if (!fullPath.startsWith(`${baseDir}${path.sep}`)) return null;
    return fullPath;
}

async function emitNewProject(userId: string, project: ProjectRecord): Promise<void> {
    const updateSeq = await allocateUserSeq(userId);
    eventRouter.emitUpdate({
        userId,
        payload: buildNewProjectUpdate(project, updateSeq, randomKeyNaked(12)),
        recipientFilter: { type: 'user-scoped-only' },
    });
}

async function emitProjectUpdate(
    userId: string,
    project: ProjectRecord,
): Promise<void> {
    const updateSeq = await allocateUserSeq(userId);
    eventRouter.emitUpdate({
        userId,
        payload: buildUpdateProjectUpdate(project, updateSeq, randomKeyNaked(12)),
        recipientFilter: { type: 'user-scoped-only' },
    });
}

export function projectRoutes(app: Fastify) {
    app.post('/v1/projects', {
        preHandler: app.authenticate,
        schema: { body: projectCreateBody },
    }, async (request, reply) => {
        const userId = request.userId;
        const { externalId } = request.body;
        const existing = await db.project.findFirst({ where: { accountId: userId, externalId } });
        if (existing) {
            // POST is intentionally create-or-load. Metadata changes use PATCH
            // so a retry cannot silently overwrite a newer encrypted record.
            return reply.send(serializeProject(existing as ProjectRecord));
        }

        let project: ProjectRecord;
        try {
            project = await db.project.create({
                data: {
                    accountId: userId,
                    externalId,
                    metadata: request.body.metadata,
                    metadataVersion: 1,
                    dataEncryptionKey: decodeDataKey(request.body.dataEncryptionKey),
                },
            }) as ProjectRecord;
        } catch (error: any) {
            // A concurrent retry may win the unique (accountId, externalId)
            // insert. Treat that race exactly like an idempotent load.
            if (error?.code !== 'P2002') throw error;
            const concurrent = await db.project.findFirst({ where: { accountId: userId, externalId } });
            if (!concurrent) throw error;
            return reply.send(serializeProject(concurrent as ProjectRecord));
        }

        await emitNewProject(userId, project);
        return reply.send(serializeProject(project));
    });

    app.get('/v1/projects', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                changedSince: z.coerce.number().int().positive().optional(),
                ids: z.string().min(1).max(32_768).optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const query = (request.query || {}) as { changedSince?: number; ids?: string };
        const ids = query.ids ? [...new Set(query.ids.split(','))] : undefined;
        if (ids && (ids.length > 100 || ids.some((id) => id.length === 0 || id.length > 256))) {
            return reply.code(400).send({ error: 'Invalid project ids' });
        }
        const projects = await db.project.findMany({
            where: {
                accountId: request.userId,
                ...(ids ? { id: { in: ids } } : {}),
                ...(query.changedSince ? { updatedAt: { gt: new Date(query.changedSince) } } : {}),
            },
            orderBy: { updatedAt: 'desc' },
        });
        return reply.send({
            projects: projects.map((project) => serializeProject(project as ProjectRecord)),
        });
    });

    app.get('/v1/projects/:projectId', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams },
    }, async (request, reply) => {
        const project = await db.project.findFirst({
            where: { id: request.params.projectId, accountId: request.userId },
        });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        return reply.send(serializeProject(project as ProjectRecord));
    });

    app.patch('/v1/projects/:projectId', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams, body: projectPatchBody },
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const current = await db.project.findFirst({ where: { id: projectId, accountId: userId } });
        if (!current) return reply.code(404).send({ error: 'Project not found' });

        const expectedMetadataVersion = request.body.expectedMetadataVersion;

        if (expectedMetadataVersion !== undefined && expectedMetadataVersion !== current.metadataVersion) {
            return reply.code(409).send({
                error: 'Project metadata version mismatch',
                project: serializeProject(current as ProjectRecord),
            });
        }

        const { metadata } = request.body;
        if (metadata === undefined || metadata === current.metadata) {
            return reply.send(serializeProject(current as ProjectRecord));
        }

        let project: ProjectRecord;
        try {
            project = await db.project.update({
                where: {
                    id: projectId,
                    ...(expectedMetadataVersion !== undefined
                        ? { metadataVersion: expectedMetadataVersion }
                        : {}),
                },
                data: {
                    metadata,
                    metadataVersion: { increment: 1 },
                    seq: { increment: 1 },
                },
            }) as ProjectRecord;
        } catch (error: any) {
            if (error?.code === 'P2025' && expectedMetadataVersion !== undefined) {
                const latest = await db.project.findFirst({ where: { id: projectId, accountId: userId } });
                return reply.code(409).send({
                    error: 'Project metadata version mismatch',
                    project: latest ? serializeProject(latest as ProjectRecord) : null,
                });
            }
            throw error;
        }
        await emitProjectUpdate(userId, project);
        return reply.send(serializeProject(project));
    });

    app.patch('/v1/projects/:projectId/avatar', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams, body: avatarActivateBody },
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const current = await db.project.findFirst({ where: { id: projectId, accountId: userId } });
        if (!current) return reply.code(404).send({ error: 'Project not found' });
        if (!projectAvatarRef(projectId, request.body.ref)) {
            return reply.code(400).send({ error: 'Invalid project avatar ref' });
        }
        if (isLocalStorage()) {
            const fullPath = localProjectAvatarPath(projectId, request.body.ref);
            if (!fullPath || !fs.existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Project avatar upload not found' });
            }
        } else {
            try {
                await s3client.statObject(s3bucket, request.body.ref);
            } catch {
                return reply.code(404).send({ error: 'Project avatar upload not found' });
            }
        }

        const unchanged = current.avatarRef === request.body.ref && current.avatarPreview === request.body.preview;
        if (unchanged) return reply.send(serializeProject(current as ProjectRecord));

        const project = await db.project.update({
            where: { id: projectId },
            data: {
                avatarRef: request.body.ref,
                avatarPreview: request.body.preview,
                avatarVersion: { increment: 1 },
                seq: { increment: 1 },
            },
        }) as ProjectRecord;
        await emitProjectUpdate(userId, project);
        return reply.send(serializeProject(project));
    });

    app.delete('/v1/projects/:projectId/avatar', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams },
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const current = await db.project.findFirst({ where: { id: projectId, accountId: userId } });
        if (!current) return reply.code(404).send({ error: 'Project not found' });
        if (!current.avatarRef && !current.avatarPreview) return reply.send(serializeProject(current as ProjectRecord));

        const project = await db.project.update({
            where: { id: projectId },
            data: {
                avatarRef: null,
                avatarPreview: null,
                avatarVersion: { increment: 1 },
                seq: { increment: 1 },
            },
        }) as ProjectRecord;
        await emitProjectUpdate(userId, project);
        try {
            await deleteProjectAvatars(projectId);
        } catch {
            // Database state is authoritative; stale encrypted blobs are
            // harmless and will be removed with the project prefix later.
        }
        return reply.send(serializeProject(project));
    });

    app.delete('/v1/projects/:projectId', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams },
    }, async (request, reply) => {
        const userId = request.userId;
        const { projectId } = request.params;
        const deleted = await inTx(async (tx) => {
            const project = await tx.project.findFirst({ where: { id: projectId, accountId: userId } });
            if (!project) return false;
            const linkedSessions = await tx.session.findMany({
                where: { projectId },
                select: { id: true },
            });

            // Unlink first so linked sessions can receive project-link updates.
            await tx.session.updateMany({ where: { projectId }, data: { projectId: null } });
            await tx.project.delete({ where: { id: projectId } });
            afterTx(tx, async () => {
                for (const session of linkedSessions) {
                    const sessionUpdateSeq = await allocateUserSeq(userId);
                    eventRouter.emitUpdate({
                        userId,
                        payload: buildUpdateSessionUpdate(
                            session.id,
                            sessionUpdateSeq,
                            randomKeyNaked(12),
                            undefined,
                            undefined,
                            null,
                        ),
                        recipientFilter: { type: 'user-scoped-only' },
                    });
                }
                const updateSeq = await allocateUserSeq(userId);
                eventRouter.emitUpdate({
                    userId,
                    payload: buildDeleteProjectUpdate(projectId, updateSeq, randomKeyNaked(12)),
                    recipientFilter: { type: 'user-scoped-only' },
                });
                try {
                    await deleteProjectAvatars(projectId);
                } catch {
                    // Storage cleanup is best effort; the database deletion
                    // and user-visible event have already committed.
                }
            });
            return true;
        });

        if (!deleted) return reply.code(404).send({ error: 'Project not found' });
        return reply.send({ success: true });
    });

    app.post('/v1/projects/:projectId/avatar/request-upload', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams, body: uploadRequestBody },
    }, async (request, reply) => {
        const userId = request.userId;
        if (!checkUploadRate(userId)) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }
        const project = await db.project.findFirst({ where: { id: request.params.projectId, accountId: userId } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });

        const ref = `projects/${project.id}/avatar/${crypto.randomUUID()}.enc`;
        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            return reply.send({
                ref,
                uploadUrl: `${baseUrl}/v1/projects/${project.id}/avatar/${ref.slice(ref.lastIndexOf('/') + 1)}`,
                method: 'PUT',
            });
        }

        const policy = s3client.newPostPolicy();
        policy.setBucket(s3bucket);
        policy.setKey(ref);
        policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
        policy.setContentLengthRange(0, MAX_FILE_SIZE);
        const { postURL, formData } = await s3client.presignedPostPolicy(policy);
        return reply.send({ ref, uploadUrl: postURL, method: 'POST', formFields: formData as Record<string, string> });
    });

    app.put('/v1/projects/:projectId/avatar/:avatarFile', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams.extend({ avatarFile: z.string() }) },
    }, async (request, reply) => {
        if (!isLocalStorage()) return reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
        const { projectId, avatarFile } = request.params;
        const project = await db.project.findFirst({ where: { id: projectId, accountId: request.userId } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        if (!projectAvatarRef(projectId, `projects/${projectId}/avatar/${avatarFile}`)) {
            return reply.code(404).send({ error: 'Invalid project avatar file' });
        }
        const body = request.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }
        await putLocalFile(`projects/${projectId}/avatar/${avatarFile}`, body);
        return reply.send({ ok: true });
    });

    // Download always resolves the currently activated ref. Callers cannot
    // use this endpoint as an arbitrary project-prefix file oracle.
    app.post('/v1/projects/:projectId/avatar/request-download', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams },
    }, async (request, reply) => {
        const project = await db.project.findFirst({ where: { id: request.params.projectId, accountId: request.userId } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        if (!project.avatarRef || !projectAvatarRef(project.id, project.avatarRef)) {
            return reply.code(404).send({ error: 'Project avatar not found' });
        }
        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            return reply.send({
                ref: project.avatarRef,
                downloadUrl: `${baseUrl}/v1/projects/${project.id}/avatar/${project.avatarRef.slice(project.avatarRef.lastIndexOf('/') + 1)}`,
            });
        }
        const downloadUrl = await s3client.presignedGetObject(s3bucket, project.avatarRef, PRESIGNED_TTL_SECONDS);
        return reply.send({ ref: project.avatarRef, downloadUrl });
    });

    app.get('/v1/projects/:projectId/avatar/:avatarFile', {
        preHandler: app.authenticate,
        schema: { params: projectIdParams.extend({ avatarFile: z.string() }) },
    }, async (request, reply) => {
        if (!isLocalStorage()) return reply.code(404).send({ error: 'Direct download not available in S3 mode' });
        const { projectId, avatarFile } = request.params;
        const project = await db.project.findFirst({ where: { id: projectId, accountId: request.userId } });
        if (!project) return reply.code(404).send({ error: 'Project not found' });
        const ref = `projects/${projectId}/avatar/${avatarFile}`;
        if (!projectAvatarRef(projectId, ref)) return reply.code(404).send({ error: 'Invalid project avatar file' });
        if (project.avatarRef !== ref) return reply.code(404).send({ error: 'Project avatar not found' });
        const fullPath = localProjectAvatarPath(projectId, ref);
        if (!fullPath) return reply.code(404).send({ error: 'Invalid project avatar file' });
        if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'Project avatar not found' });
        return reply.type('application/octet-stream').send(fs.readFileSync(fullPath));
    });
}
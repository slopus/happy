import * as crypto from 'crypto';
import { z } from 'zod';

import type { Fastify } from '@/app/api/types';
import { isLocalStorage, putLocalFile, s3bucket, s3client } from '@/storage/files';
import { deleteRelationshipAdvisorImages } from '@/modules/relationship-advisor/relationshipAdvisorImages';
import { pluginRegistry } from '@/modules/plugins/pluginRegistry';

const MAX_ADVISOR_IMAGE_SIZE = 10 * 1024 * 1024;
const ADVISOR_UPLOAD_TTL_SECONDS = 10 * 60;
const uploadRateState = new Map<string, { startedAt: number; count: number }>();
const RELATIONSHIP_ADVISOR_PLUGIN_ID = 'relationship-advisor';
const IMAGE_WRITE_PERMISSION = 'paws.storage.images.write';

const IMAGE_EXTENSION_BY_MIME = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
} as const;

function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedProtocol = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
    const protocol = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol) ?? 'http';
    return typeof host === 'string' && host ? `${protocol}://${host}` : `http://localhost:${process.env.PORT || '3005'}`;
}

function canRequestAdvisorImageUpload(userId: string): boolean {
    const now = Date.now();
    const state = uploadRateState.get(userId);
    if (!state || now - state.startedAt >= 60_000) {
        uploadRateState.set(userId, { startedAt: now, count: 1 });
        return true;
    }
    if (state.count >= 30) return false;
    state.count++;
    return true;
}

export function relationshipAdvisorRoutes(app: Fastify) {
    app.post('/v1/relationship-advisor/images/request-upload', {
        schema: {
            body: z.object({
                mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
                size: z.number().int().positive().max(MAX_ADVISOR_IMAGE_SIZE),
            }),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                    method: z.enum(['PUT', 'POST']),
                    formFields: z.record(z.string(), z.string()).optional(),
                }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await pluginRegistry.requirePermission(
            request.userId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            IMAGE_WRITE_PERMISSION,
        );
        if (!canRequestAdvisorImageUpload(request.userId)) {
            return reply.code(429).send({ error: 'Too many image uploads' });
        }
        const extension = IMAGE_EXTENSION_BY_MIME[request.body.mimeType];
        const filename = `${crypto.randomUUID()}${extension}`;
        const ref = `advisor/${request.userId}/${filename}`;

        if (!isLocalStorage()) {
            const policy = s3client.newPostPolicy();
            policy.setBucket(s3bucket);
            policy.setKey(ref);
            policy.setExpires(new Date(Date.now() + ADVISOR_UPLOAD_TTL_SECONDS * 1_000));
            policy.setContentLengthRange(0, MAX_ADVISOR_IMAGE_SIZE);
            const { postURL, formData } = await s3client.presignedPostPolicy(policy);
            return reply.send({
                ref,
                uploadUrl: postURL,
                method: 'POST',
                formFields: formData as Record<string, string>,
            });
        }

        return reply.send({
            ref,
            uploadUrl: `${resolveBaseUrl(request)}/v1/relationship-advisor/images/${filename}`,
            method: 'PUT',
        });
    });

    app.put('/v1/relationship-advisor/images/:filename', {
        bodyLimit: MAX_ADVISOR_IMAGE_SIZE,
        schema: {
            params: z.object({
                filename: z.string().regex(/^[a-f0-9-]{20,64}\.(?:jpg|png|webp)$/),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await pluginRegistry.requirePermission(
            request.userId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            IMAGE_WRITE_PERMISSION,
        );
        if (!isLocalStorage()) {
            return reply.code(404).send({ error: 'Direct upload is not available' });
        }
        const body = request.body as unknown;
        if (!Buffer.isBuffer(body)) {
            return reply.code(413).send({ error: 'Invalid image body' });
        }
        if (body.length > MAX_ADVISOR_IMAGE_SIZE) {
            return reply.code(413).send({ error: 'Image is too large' });
        }
        await putLocalFile(`advisor/${request.userId}/${request.params.filename}`, body);
        return reply.send({ ok: true });
    });

    app.delete('/v1/relationship-advisor/images', {
        schema: {
            body: z.object({
                refs: z.array(z.string().regex(
                    /^advisor\/[A-Za-z0-9_-]{1,128}\/[a-f0-9-]{20,64}\.(?:jpe?g|png|webp)$/,
                )).max(4),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await pluginRegistry.requirePermission(
            request.userId,
            RELATIONSHIP_ADVISOR_PLUGIN_ID,
            IMAGE_WRITE_PERMISSION,
        );
        await deleteRelationshipAdvisorImages(request.userId, request.body.refs);
        return reply.send({ ok: true });
    });
}

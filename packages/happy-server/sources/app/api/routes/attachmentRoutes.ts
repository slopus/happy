/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * No database records — attachments are identified by their ref path.
 * Cleanup happens when sessions are deleted (Phase 8).
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir, putLocalFile } from '@/storage/files';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function attachmentRoutes(app: Fastify) {

    /**
     * Request an upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl to PUT the encrypted blob to.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                filename: z.string(),
                size: z.number().max(MAX_FILE_SIZE),
                mimeType: z.string().optional(),
            }),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { filename, size } = request.body;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Generate unique ref
        const attachmentId = crypto.randomUUID();
        const ext = path.extname(filename) || '.enc';
        const ref = `sessions/${sessionId}/attachments/${attachmentId}${ext}`;

        if (isLocalStorage()) {
            // Local mode: client uploads to our own PUT endpoint
            const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
            const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentId}${ext}`;
            return reply.send({ ref, uploadUrl });
        } else {
            // S3 mode: return presigned PUT URL
            const uploadUrl = await s3client.presignedPutObject(s3bucket, ref, 3600);
            return reply.send({ ref, uploadUrl });
        }
    });

    /**
     * Local storage: accept encrypted blob upload via PUT.
     * Only active when S3 is not configured.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        if (!isLocalStorage()) {
            return reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
        }

        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const body = request.body as Buffer;
        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        await putLocalFile(ref, body);

        return reply.send({ ok: true });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3).
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (isLocalStorage()) {
            const fullPath = path.join(getLocalFilesDir(), ref);
            if (!fs.existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Attachment not found' });
            }
            reply.header('Content-Type', 'application/octet-stream');
            return reply.type('application/octet-stream').send(fs.readFileSync(fullPath));
        } else {
            // S3 mode: redirect to presigned GET URL
            const url = await s3client.presignedGetObject(s3bucket, ref, 3600);
            return reply.redirect(url);
        }
    });
}

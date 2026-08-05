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

// Images stay capped at 50MB. S3 media uploads stream from the client and get
// the larger ceiling; local PUT is still buffered by Fastify and remains 50MB.
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — image lane / local PUT
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB — S3 plaintext media lane
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, { kind: 'audio' | 'video'; mimeType: string }>> = {
    '.mp4': { kind: 'video', mimeType: 'video/mp4' },
    '.m4v': { kind: 'video', mimeType: 'video/x-m4v' },
    '.mov': { kind: 'video', mimeType: 'video/quicktime' },
    '.webm': { kind: 'video', mimeType: 'video/webm' },
    '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
    '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
    '.aac': { kind: 'audio', mimeType: 'audio/aac' },
    '.wav': { kind: 'audio', mimeType: 'audio/wav' },
    '.flac': { kind: 'audio', mimeType: 'audio/flac' },
    '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
    '.opus': { kind: 'audio', mimeType: 'audio/opus' },
};

function mediaExtension(filename: string, kind: 'audio' | 'video'): string {
    const extension = path.extname(filename).toLowerCase();
    return MEDIA_MIME_BY_EXTENSION[extension]?.kind === kind ? extension : '.media';
}

function attachmentContentType(filename: string): string {
    return MEDIA_MIME_BY_EXTENSION[path.extname(filename).toLowerCase()]?.mimeType ?? 'application/octet-stream';
}

function maxSizeForKind(kind: 'image' | 'audio' | 'video' | undefined): number {
    return kind === 'audio' || kind === 'video' ? MAX_MEDIA_SIZE : MAX_FILE_SIZE;
}

// Per-user, per-process token bucket for request-upload. Best-effort flood
// protection — on a multi-process deploy each instance counts independently,
// so an attacker with N processes gets N×limit. Adequate as a backstop
// against a single-client loop generating presigned URLs forever.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const uploadRateState = new Map<string, { count: number; windowStart: number }>();

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then x-forwarded-* (for
 * deployments behind a proxy), then the Host header the request itself
 * arrived on. Falling back to localhost would make any non-localhost client
 * (a phone, another LAN device, a desktop pointing at a dev IP) fail with a
 * generic Network request failed when it tries to follow the URL.
 */
function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const xfHost = request.headers['x-forwarded-host'];
    const xfProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost) ?? request.headers.host;
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) ?? 'http';
    if (typeof host === 'string' && host.length > 0) {
        return `${proto}://${host}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}

function checkUploadRate(userId: string): boolean {
    const now = Date.now();
    const entry = uploadRateState.get(userId);
    if (!entry || now - entry.windowStart >= UPLOAD_RATE_WINDOW_MS) {
        uploadRateState.set(userId, { count: 1, windowStart: now });
        // Opportunistic prune so the map cannot grow forever from one-shot
        // users churning through the system.
        if (uploadRateState.size > 10_000) {
            for (const [k, v] of uploadRateState) {
                if (now - v.windowStart >= UPLOAD_RATE_WINDOW_MS) {
                    uploadRateState.delete(k);
                }
            }
        }
        return true;
    }
    if (entry.count >= UPLOAD_RATE_MAX) return false;
    entry.count++;
    return true;
}

function getLocalAttachmentPath(ref: string): string {
    return path.join(getLocalFilesDir(), ref);
}

function hasLocalAttachment(ref: string): boolean {
    return fs.existsSync(getLocalAttachmentPath(ref));
}

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
                // Upper bound is the media ceiling; the per-kind limit is
                // enforced in the handler so images still reject above 50MB.
                size: z.number().max(MAX_MEDIA_SIZE),
                // Attachment lane. Omitted → 'image' (back-compat with existing
                // clients that only ever uploaded encrypted images).
                kind: z.enum(['image', 'audio', 'video']).optional(),
            }),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                    method: z.enum(['PUT', 'POST']),
                    formFields: z.record(z.string(), z.string()).optional(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size, kind } = request.body;
        const userId = request.userId;
        const isMedia = kind === 'audio' || kind === 'video';

        if (!checkUploadRate(userId)) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const maxSize = isLocalStorage() ? MAX_FILE_SIZE : maxSizeForKind(kind);
        if (size > maxSize) {
            return reply.code(413).send({ error: `File too large (max ${Math.floor(maxSize / (1024 * 1024))}MB)` });
        }

        // Images are opaque .enc blobs. Media keeps only an allowlisted suffix
        // so presigned/local download responses remain directly playable.
        const attachmentId = crypto.randomUUID();
        const mediaKind = kind === 'audio' ? 'audio' : 'video';
        const attachmentFile = isMedia ? `${attachmentId}${mediaExtension(request.body.filename, mediaKind)}` : `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        if (isLocalStorage()) {
            // Local mode: client uploads to our own PUT endpoint (the server
            // enforces the size limit by inspecting the request body before
            // it hits disk, so PUT is fine here).
            const baseUrl = resolveBaseUrl(request);
            const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else if (isMedia) {
            // S3 mode, audio/video: presigned PUT. A 500MB plaintext file must
            // be streamed from disk (expo-file-system uploadAsync BINARY) — a
            // POST policy form upload would force buffering. PUT cannot enforce
            // content-length in the signature, so size is bounded only by the
            // client-honest request-upload call above + the per-user rate
            // limit + the private bucket. Acceptable for self-hosted use.
            const uploadUrl = await s3client.presignedPutObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else {
            // S3 mode, image: presigned POST policy with content-length-range so
            // S3 itself rejects oversize uploads — a presigned PUT cannot
            // enforce size and would let a client honest about size in the auth
            // call PUT 500MB at the URL afterwards.
            const policy = s3client.newPostPolicy();
            policy.setBucket(s3bucket);
            policy.setKey(ref);
            policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
            policy.setContentLengthRange(0, MAX_FILE_SIZE);
            const { postURL, formData } = await s3client.presignedPostPolicy(policy);
            return reply.send({
                ref,
                uploadUrl: postURL,
                method: 'POST',
                formFields: formData as Record<string, string>,
            });
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
            return reply.code(413).send({ error: 'File too large (max 50MB)' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        await putLocalFile(ref, body);

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET — in local mode it points back at
     * this server (auth-required), in S3 mode it is a presigned GET URL.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                ref: z.string(),
            }),
            response: {
                200: z.object({
                    downloadUrl: z.string(),
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref } = request.body;
        const userId = request.userId;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // ref must live strictly under this session's attachments prefix —
        // otherwise a member of session A could craft a ref pointing into
        // session B and ride this endpoint's auth to read it.
        const expectedPrefix = `sessions/${sessionId}/attachments/`;
        if (!ref.startsWith(expectedPrefix)) {
            return reply.code(400).send({ error: 'Ref does not belong to this session' });
        }
        const attachmentFile = ref.slice(expectedPrefix.length);
        if (!attachmentFile || attachmentFile.includes('/') || attachmentFile.includes('..')) {
            return reply.code(400).send({ error: 'Invalid attachment ref' });
        }

        if (isLocalStorage() || hasLocalAttachment(ref)) {
            const baseUrl = resolveBaseUrl(request);
            const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ downloadUrl });
        }
        const downloadUrl = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
        return reply.send({ downloadUrl });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3). Backs the URL returned by
     * /request-download in local mode; clients can also call this directly.
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

        if (isLocalStorage() || hasLocalAttachment(ref)) {
            const fullPath = getLocalAttachmentPath(ref);
            if (!fs.existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Attachment not found' });
            }
            const contentType = attachmentContentType(attachmentFile);
            reply.header('Content-Type', contentType);
            return reply.type(contentType).send(fs.readFileSync(fullPath));
        } else {
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.redirect(url);
        }
    });
}

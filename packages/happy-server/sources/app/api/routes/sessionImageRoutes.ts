import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { s3bucket, s3client, s3public } from "@/storage/files";
import { randomKey } from "@/utils/randomKey";
import sharp from "sharp";
import { log } from "@/utils/log";

const MAX_DIMENSION = 2048;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export function sessionImageRoutes(app: Fastify) {

    // POST /v1/sessions/:id/images - Upload an image for a chat session
    app.post('/v1/sessions/:id/images', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
        },
        config: {
            rawBody: true,
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const sessionId = request.params.id;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Get raw body as buffer
        const body = request.body as Buffer;
        if (!body || body.length === 0) {
            return reply.code(400).send({ error: 'No image data provided' });
        }

        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'Image too large (max 20MB)' });
        }

        try {
            // Read image metadata with sharp
            const metadata = await sharp(body).metadata();
            if (!metadata.width || !metadata.height) {
                return reply.code(400).send({ error: 'Invalid image' });
            }

            // Determine output format
            const supportedFormats = ['jpeg', 'png', 'gif', 'webp'];
            const inputFormat = metadata.format;
            const outputFormat = supportedFormats.includes(inputFormat || '') ? inputFormat! : 'jpeg';

            // Resize if needed (max 2048px on longest side)
            let processedBuffer: Buffer;
            const needsResize = metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION;

            if (needsResize || !supportedFormats.includes(inputFormat || '')) {
                let pipeline = sharp(body);

                if (needsResize) {
                    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
                        fit: 'inside',
                        withoutEnlargement: true,
                    });
                }

                if (outputFormat === 'jpeg') {
                    pipeline = pipeline.jpeg({ quality: 85 });
                } else if (outputFormat === 'png') {
                    pipeline = pipeline.png();
                } else if (outputFormat === 'webp') {
                    pipeline = pipeline.webp({ quality: 85 });
                } else if (outputFormat === 'gif') {
                    pipeline = pipeline.gif();
                }

                processedBuffer = await pipeline.toBuffer();
            } else {
                processedBuffer = body;
            }

            // Get final dimensions
            const finalMeta = needsResize ? await sharp(processedBuffer).metadata() : metadata;
            const width = finalMeta.width!;
            const height = finalMeta.height!;

            // Upload to MinIO
            const ext = outputFormat === 'jpeg' ? 'jpg' : outputFormat;
            const key = randomKey('img');
            const mediaType = `image/${outputFormat}`;
            const s3Path = `chat-images/${userId}/${sessionId}/${key}.${ext}`;

            await s3client.putObject(s3bucket, s3Path, processedBuffer, processedBuffer.length, {
                'Content-Type': mediaType,
            });

            const publicUrl = `${s3public}/${s3Path}`;

            log({ module: 'session-image', userId, sessionId }, `Image uploaded: ${s3Path} (${width}x${height})`);

            return reply.send({
                url: publicUrl,
                mediaType,
                width,
                height,
            });
        } catch (error: any) {
            log({ module: 'session-image', level: 'error', userId, sessionId }, `Failed to upload image: ${error.message}`);
            return reply.code(500).send({ error: 'Failed to process image' });
        }
    });
}

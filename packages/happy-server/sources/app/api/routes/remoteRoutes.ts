import { z } from "zod";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { randomKey } from "@/utils/randomKey";
import { s3bucket, s3client, s3public } from "@/storage/files";
import sharp from "sharp";

// Parse "в brain проверь докер" → { label: "brain", text: "проверь докер" }
// Parse "brain: проверь докер"  → { label: "brain", text: "проверь докер" }
// Parse "проверь докер"         → { label: null, text: "проверь докер" }
function parseTargetFromText(raw: string): { label: string | null; text: string } {
    // Pattern: "в <label> <text>" (Russian voice input)
    const ruMatch = raw.match(/^[вВ]\s+(\S+)\s+(.+)$/s);
    if (ruMatch) {
        return { label: ruMatch[1].toLowerCase(), text: ruMatch[2].trim() };
    }
    // Pattern: "<label>: <text>"
    const colonMatch = raw.match(/^(\S+):\s+(.+)$/s);
    if (colonMatch) {
        return { label: colonMatch[1].toLowerCase(), text: colonMatch[2].trim() };
    }
    return { label: null, text: raw };
}

function checkRemoteApiKey(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const apiKey = authHeader.substring(7);
    const expectedKey = process.env.HAPPY_API_KEY;
    return !!expectedKey && apiKey === expectedKey;
}

async function findSessionByLabel(label: string | null) {
    if (label) {
        let session = await db.session.findFirst({
            where: { active: true, publicLabel: label },
            orderBy: { updatedAt: 'desc' }
        });
        if (!session) {
            session = await db.session.findFirst({
                where: { active: true, publicLabel: { startsWith: label } },
                orderBy: { updatedAt: 'desc' }
            });
        }
        return session;
    }
    return db.session.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' }
    });
}

const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

export function remoteRoutes(app: Fastify) {
    // Send a message to an active Claude session
    app.post('/v1/remote/command', {
        schema: {
            body: z.object({
                text: z.string().min(1),
                label: z.string().nullish(), // Explicit label override
            })
        }
    }, async (request, reply) => {
        if (!checkRemoteApiKey(request.headers.authorization)) {
            return reply.code(401).send({ error: 'Invalid API key' });
        }

        const { text: rawText, label: explicitLabel } = request.body;

        // Parse target label from text if not provided explicitly
        const parsed = explicitLabel
            ? { label: explicitLabel.toLowerCase(), text: rawText }
            : parseTargetFromText(rawText);

        log({ module: 'remote' }, `Remote command: label=${parsed.label || 'auto'}, text="${parsed.text.substring(0, 80)}"`);

        const session = await findSessionByLabel(parsed.label);
        if (!session) {
            return reply.code(404).send({
                error: parsed.label ? `No active session with label "${parsed.label}"` : 'No active sessions found',
                hint: 'Available labels can be found via GET /v1/remote/sessions'
            });
        }

        const accountId = session.accountId;

        // Create plaintext message (service channel, no E2E encryption)
        const msgContent = {
            t: 'plaintext' as const,
            role: 'user',
            text: parsed.text,
            meta: {
                sentFrom: 'remote',
                sentVia: 'siri',
                permissionMode: 'default'
            }
        };

        // Allocate sequences
        const updSeq = await allocateUserSeq(accountId);
        const msgSeq = await allocateSessionSeq(session.id);

        // Save to database and update session.updatedAt to track user interaction
        const [msg] = await Promise.all([
            db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: msgSeq,
                    content: msgContent as any
                }
            }),
            db.session.update({
                where: { id: session.id },
                data: { updatedAt: new Date() }
            })
        ]);

        // Broadcast to all session-scoped clients (Claude process will receive it)
        const updatePayload = buildNewMessageUpdate(msg, session.id, updSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({
            userId: accountId,
            payload: updatePayload,
            recipientFilter: { type: 'all-interested-in-session', sessionId: session.id }
        });

        log({ module: 'remote' }, `Remote command sent to session ${session.id} (label: ${session.publicLabel || 'none'})`);

        const webappUrl = process.env.HAPPY_WEBAPP_URL || 'https://happy.304.systems';
        return reply.send({
            ok: true,
            sessionId: session.id,
            label: session.publicLabel || null,
            webUrl: `${webappUrl}/session/${session.id}`
        });
    });

    // List active sessions (for Siri/remote tools to discover targets)
    app.get('/v1/remote/sessions', async (request, reply) => {
        if (!checkRemoteApiKey(request.headers.authorization)) {
            return reply.code(401).send({ error: 'Invalid API key' });
        }

        const sessions = await db.session.findMany({
            where: { active: true },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                publicLabel: true,
                active: true,
                lastActiveAt: true,
                updatedAt: true,
                createdAt: true
            }
        });

        return reply.send({
            sessions: sessions.map(s => ({
                id: s.id,
                label: s.publicLabel,
                lastActiveAt: s.lastActiveAt.getTime(),
                updatedAt: s.updatedAt.getTime(),
                createdAt: s.createdAt.getTime()
            }))
        });
    });

    // Send an image to an active Claude session (for iOS Shortcuts)
    // Body: raw image binary, query params: ?text=optional&label=optional
    app.post('/v1/remote/image', {
        schema: {
            querystring: z.object({
                text: z.string().optional(),
                label: z.string().optional(),
            })
        },
        config: {
            rawBody: true,
        }
    }, async (request, reply) => {
        if (!checkRemoteApiKey(request.headers.authorization)) {
            return reply.code(401).send({ error: 'Invalid API key' });
        }

        const { text, label } = request.query as { text?: string; label?: string };

        // Find target session
        const session = await findSessionByLabel(label || null);
        if (!session) {
            return reply.code(404).send({
                error: label ? `No active session with label "${label}"` : 'No active sessions found',
            });
        }

        // Validate image body
        const body = request.body as Buffer;
        if (!body || body.length === 0) {
            return reply.code(400).send({ error: 'No image data provided' });
        }
        if (body.length > MAX_IMAGE_SIZE) {
            return reply.code(413).send({ error: 'Image too large (max 20MB)' });
        }

        try {
            // Process image with sharp
            const metadata = await sharp(body).metadata();
            if (!metadata.width || !metadata.height) {
                return reply.code(400).send({ error: 'Invalid image' });
            }

            const supportedFormats = ['jpeg', 'png', 'gif', 'webp'];
            const inputFormat = metadata.format;
            const outputFormat = supportedFormats.includes(inputFormat || '') ? inputFormat! : 'jpeg';

            // Resize if needed
            let processedBuffer: Buffer;
            const needsResize = metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION;

            if (needsResize || !supportedFormats.includes(inputFormat || '')) {
                let pipeline = sharp(body);
                if (needsResize) {
                    pipeline = pipeline.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
                        fit: 'inside',
                        withoutEnlargement: true,
                    });
                }
                if (outputFormat === 'jpeg') pipeline = pipeline.jpeg({ quality: 85 });
                else if (outputFormat === 'png') pipeline = pipeline.png();
                else if (outputFormat === 'webp') pipeline = pipeline.webp({ quality: 85 });
                else if (outputFormat === 'gif') pipeline = pipeline.gif();

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
            const accountId = session.accountId;
            const s3Path = `chat-images/${accountId}/${session.id}/${key}.${ext}`;

            await s3client.putObject(s3bucket, s3Path, processedBuffer, processedBuffer.length, {
                'Content-Type': mediaType,
            });

            const imageUrl = `${s3public}/${s3Path}`;

            // Create message with image
            const messageText = text || 'Analyze this image';
            const msgContent = {
                t: 'plaintext' as const,
                role: 'user',
                text: messageText,
                images: [{
                    url: imageUrl,
                    mediaType,
                    width,
                    height,
                }],
                meta: {
                    sentFrom: 'remote',
                    sentVia: 'shortcut',
                    permissionMode: 'default'
                }
            };

            // Allocate sequences and save
            const updSeq = await allocateUserSeq(accountId);
            const msgSeq = await allocateSessionSeq(session.id);

            const [msg] = await Promise.all([
                db.sessionMessage.create({
                    data: {
                        sessionId: session.id,
                        seq: msgSeq,
                        content: msgContent as any
                    }
                }),
                db.session.update({
                    where: { id: session.id },
                    data: { updatedAt: new Date() }
                })
            ]);

            // Broadcast to session
            const updatePayload = buildNewMessageUpdate(msg, session.id, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: accountId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: session.id }
            });

            log({ module: 'remote' }, `Remote image sent to session ${session.id} (${width}x${height})`);

            const webappUrl = process.env.HAPPY_WEBAPP_URL || 'https://happy.304.systems';
            return reply.send({
                ok: true,
                sessionId: session.id,
                label: session.publicLabel || null,
                imageUrl,
                webUrl: `${webappUrl}/session/${session.id}`
            });
        } catch (error: any) {
            log({ module: 'remote', level: 'error' }, `Remote image upload failed: ${error.message}`);
            return reply.code(500).send({ error: 'Failed to process image' });
        }
    });
}

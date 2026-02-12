import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from '../runtime/env';
import { logError, logInfo } from '../runtime/log';
import {
    buildParticipantIdentity,
    buildParticipantToken,
    buildRoomName,
    deleteRoom,
    dispatchAgent,
    ensureRoom,
    sendRoomData,
} from '../runtime/livekit';
import { sessionStore } from '../runtime/sessionStore';
import type {
    HappyVoiceContextPayload,
    VoiceSessionRecord,
    VoiceStartRequest,
    VoiceStartResponse,
} from '../types/voice';

function isAuthorized(request: FastifyRequest): boolean {
    const header = request.headers['x-voice-key'];
    if (typeof header === 'string' && header === env.VOICE_PUBLIC_KEY) {
        return true;
    }

    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
        const token = authorization.slice('Bearer '.length).trim();
        return token === env.VOICE_PUBLIC_KEY;
    }
    return false;
}

function rejectUnauthorized(reply: FastifyReply) {
    return reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid voice gateway key.',
    });
}

const startSchema = z.object({
    userId: z.string().min(1),
    sessionId: z.string().min(1),
    initialContextPayload: z.object({
        version: z.literal(1),
        format: z.literal('happy-app-context-v1'),
        contentType: z.literal('text/plain'),
        text: z.string().min(1),
        createdAt: z.string().min(1),
    }).optional(),
    language: z.string().optional(),
    toolBridgeBaseUrl: z.string().optional(),
    welcomeMessage: z.string().max(500).optional(),
});

const stopSchema = z.object({
    gatewaySessionId: z.string().uuid(),
});

const textSchema = z.object({
    gatewaySessionId: z.string().uuid(),
    message: z.string().min(1),
});

const contextSchema = z.object({
    gatewaySessionId: z.string().uuid(),
    payload: z.object({
        version: z.literal(1),
        format: z.literal('happy-app-context-v1'),
        contentType: z.literal('text/plain'),
        text: z.string().min(1),
        createdAt: z.string().min(1),
    }),
});

export function registerRoutes(
    app: FastifyInstance
) {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get('/healthz', async () => ({
        ok: true,
        service: 'happy-voice',
    }));

    typed.post('/v1/voice/session/start', {
        schema: {
            body: startSchema,
            response: {
                200: z.object({
                    allowed: z.boolean(),
                    gatewaySessionId: z.string().uuid(),
                    roomName: z.string(),
                    roomUrl: z.string(),
                    participantIdentity: z.string(),
                    participantToken: z.string(),
                    expiresAt: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
                500: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        if (!isAuthorized(request)) {
            return rejectUnauthorized(reply);
        }

        const body = request.body as VoiceStartRequest;
        const gatewaySessionId = randomUUID();
        const roomName = buildRoomName();
        const participantIdentity = buildParticipantIdentity();
        const now = Date.now();
        const expiresAt = new Date(now + env.LIVEKIT_TOKEN_TTL_SECONDS * 1000).toISOString();
        const metadata = JSON.stringify({
            gatewaySessionId,
            userId: body.userId,
            appSessionId: body.sessionId,
            initialContextPayload: body.initialContextPayload,
            language: body.language,
            toolBridgeBaseUrl: body.toolBridgeBaseUrl,
            welcomeMessage: body.welcomeMessage,
        });

        try {
            await ensureRoom(roomName);
            const dispatch = await dispatchAgent(roomName, metadata);
            const participantToken = await buildParticipantToken(roomName, participantIdentity);
            logInfo('Voice session started', {
                gatewaySessionId,
                roomName,
                dispatchId: dispatch.id,
                userId: body.userId,
                appSessionId: body.sessionId,
            });

            const record: VoiceSessionRecord = {
                gatewaySessionId,
                userId: body.userId,
                appSessionId: body.sessionId,
                roomName,
                participantIdentity,
                dispatchId: dispatch.id,
                state: 'active',
                initialContextPayload: body.initialContextPayload,
                language: body.language,
                createdAt: new Date(now).toISOString(),
                updatedAt: new Date(now).toISOString(),
                expiresAt,
            };
            sessionStore.set(record);

            const response: VoiceStartResponse = {
                allowed: true,
                gatewaySessionId,
                roomName,
                roomUrl: env.LIVEKIT_WS_URL || env.LIVEKIT_URL,
                participantIdentity,
                participantToken,
                expiresAt,
            };
            return reply.send(response);
        } catch (error) {
            logError('Failed to start voice session', { error, gatewaySessionId, roomName });
            return reply.code(500).send({
                error: 'start_failed',
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    typed.post('/v1/voice/session/stop', {
        schema: {
            body: stopSchema,
            response: {
                200: z.object({
                    success: z.boolean(),
                }),
                401: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        if (!isAuthorized(request)) {
            return rejectUnauthorized(reply);
        }

        const { gatewaySessionId } = stopSchema.parse(request.body);
        const record = sessionStore.get(gatewaySessionId);

        if (!record) {
            return reply.send({ success: true });
        }

        await deleteRoom(record.roomName);
        sessionStore.markState(gatewaySessionId, 'stopped');
        return reply.send({ success: true });
    });

    typed.get('/v1/voice/session/:gatewaySessionId/status', {
        schema: {
            params: z.object({
                gatewaySessionId: z.string().uuid(),
            }),
            response: {
                200: z.object({
                    found: z.boolean(),
                    session: z.any().optional(),
                }),
                401: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        if (!isAuthorized(request)) {
            return rejectUnauthorized(reply);
        }

        const { gatewaySessionId } = z.object({
            gatewaySessionId: z.string().uuid(),
        }).parse(request.params);
        const record = sessionStore.get(gatewaySessionId);
        return reply.send({
            found: !!record,
            session: record,
        });
    });

    // These endpoints keep parity with happy-app's VoiceSession interface.
    // Actual participant->agent data channel integration is done at app integration layer.
    typed.post('/v1/voice/session/text', {
        schema: {
            body: textSchema,
            response: {
                200: z.object({
                    accepted: z.boolean(),
                    note: z.string().optional(),
                }),
                401: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        if (!isAuthorized(request)) {
            return rejectUnauthorized(reply);
        }

        const { gatewaySessionId, message } = textSchema.parse(request.body);
        const record = sessionStore.get(gatewaySessionId);
        if (!record) {
            return reply.send({ accepted: false, note: 'unknown session' });
        }

        try {
            await sendRoomData(record.roomName, 'happy.voice.text', {
                kind: 'text',
                gatewaySessionId,
                appSessionId: record.appSessionId,
                userId: record.userId,
                message,
                createdAt: new Date().toISOString(),
            });
            logInfo('Text update forwarded to room', {
                gatewaySessionId,
                roomName: record.roomName,
                messagePreview: message.slice(0, 120),
            });
            return reply.send({ accepted: true });
        } catch (error) {
            logError('Failed to forward text update to room', { gatewaySessionId, error });
            return reply.send({ accepted: false, note: 'room data publish failed' });
        }
    });

    typed.post('/v1/voice/session/context', {
        schema: {
            body: contextSchema,
            response: {
                200: z.object({
                    accepted: z.boolean(),
                    note: z.string().optional(),
                }),
                401: z.object({
                    error: z.string(),
                    message: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        if (!isAuthorized(request)) {
            return rejectUnauthorized(reply);
        }

        const { gatewaySessionId, payload } = contextSchema.parse(request.body);
        const record = sessionStore.get(gatewaySessionId);
        if (!record) {
            return reply.send({ accepted: false, note: 'unknown session' });
        }

        try {
            await sendRoomData(record.roomName, 'happy.voice.context', {
                kind: 'context',
                gatewaySessionId,
                appSessionId: record.appSessionId,
                userId: record.userId,
                payload: payload as HappyVoiceContextPayload,
                createdAt: new Date().toISOString(),
            });
            logInfo('Context update forwarded to room', {
                gatewaySessionId,
                roomName: record.roomName,
                messagePreview: payload.text.slice(0, 120),
            });
            return reply.send({ accepted: true });
        } catch (error) {
            logError('Failed to forward context update to room', { gatewaySessionId, error });
            return reply.send({ accepted: false, note: 'room data publish failed' });
        }
    });
}

import { buildMessageDeliveryErrorEphemeral, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { canSendMessages } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch } from "@/storage/seq";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";
import { replayFirstMessageToCliWhenConnected } from "./firstMessageReplay";

const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
});

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        content: z.string(),
        localId: z.string().min(1),
        trackCliDelivery: z.boolean().optional().default(false)
    })).min(1).max(200)
});

type SelectedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    sentBy: string | null;
    sentByName: string | null;
    deliveryIssue?: {
        status: "waiting" | "error";
        reason: string | null;
    } | null;
    createdAt: Date;
    updatedAt: Date;
};

type SendResponseMessage = Omit<SelectedMessage, "content" | "deliveryIssue">;

function toResponseMessage(message: SelectedMessage) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        sentBy: message.sentBy,
        sentByName: message.sentByName,
        deliveryIssue: message.deliveryIssue
            ? {
                status: message.deliveryIssue.status,
                reason: message.deliveryIssue.reason
            }
            : undefined,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function toSendResponseMessage(message: SendResponseMessage) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        sentBy: message.sentBy,
        sentByName: message.sentByName,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function hasReceiptCapableCliConnection(userId: string, sessionId: string): boolean {
    const connections = eventRouter.getConnections(userId);
    if (!connections) {
        return false;
    }

    return Array.from(connections).some((connection) => (
        connection.connectionType === 'session-scoped' &&
        connection.sessionId === sessionId &&
        connection.supportsMessageReceipt
    ));
}

async function markNoCliConnectionDeliveryIssue(params: {
    ownerId: string;
    sessionId: string;
    messageId: string;
    localId: string | null;
}) {
    await db.sessionMessageDeliveryIssue.upsert({
        where: {
            sessionMessageId: params.messageId
        },
        create: {
            sessionMessageId: params.messageId,
            status: 'error',
            reason: 'no_cli_connection'
        },
        update: {
            status: 'error',
            reason: 'no_cli_connection'
        }
    });

    await eventRouter.emitEphemeralToSessionSubscribers({
        ownerId: params.ownerId,
        sessionId: params.sessionId,
        payload: buildMessageDeliveryErrorEphemeral(params.sessionId, params.messageId, params.localId, 'no_cli_connection'),
        recipientFilter: { type: 'all-interested-in-session', sessionId: params.sessionId }
    });
}

export function v3SessionRoutes(app: Fastify) {
    app.get('/v3/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: getMessagesQuerySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit } = request.query;

        if (after_seq !== undefined && before_seq !== undefined) {
            return reply.code(400).send({ error: 'Cannot specify both after_seq and before_seq' });
        }

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                OR: [
                    { accountId: userId },
                    { shares: { some: { sharedWithUserId: userId } } }
                ]
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Three modes:
        // 1. after_seq=X  → forward pagination (seq > X, asc)  — incremental sync
        // 2. before_seq=X → backward pagination (seq < X, desc) — scroll-up / older messages
        // 3. no params    → latest messages (desc)               — bootstrap
        const isForward = after_seq !== undefined;
        const seqFilter = after_seq !== undefined
            ? { gt: after_seq }
            : before_seq !== undefined
                ? { lt: before_seq }
                : undefined;
        const orderBy = isForward ? 'asc' as const : 'desc' as const;

        const messages = await db.sessionMessage.findMany({
            where: {
                sessionId,
                ...(seqFilter ? { seq: seqFilter } : {})
            },
            orderBy: { seq: orderBy },
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                content: true,
                localId: true,
                sentBy: true,
                sentByName: true,
                deliveryIssue: {
                    select: {
                        status: true,
                        reason: true
                    }
                },
                createdAt: true,
                updatedAt: true
            }
        });

        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;

        return reply.send({
            messages: page.map(toResponseMessage),
            hasMore
        });
    });

    app.post('/v3/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: sendMessagesBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { messages } = request.body;

        // Check if user can send messages (owner or shared with edit/admin access)
        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Get session owner for broadcasting
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { accountId: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const ownerId = session.accountId;
        const ownerHasReceiptCapableCli = hasReceiptCapableCliConnection(ownerId, sessionId);

        const senderAccount = await db.account.findUnique({
            where: { id: userId },
            select: { firstName: true, username: true }
        });
        const sentByName = senderAccount?.firstName || senderAccount?.username || null;

        const firstMessageByLocalId = new Map<string, { localId: string; content: string; trackCliDelivery: boolean }>();
        for (const message of messages) {
            if (!firstMessageByLocalId.has(message.localId)) {
                firstMessageByLocalId.set(message.localId, message);
            }
        }

        const uniqueMessages = Array.from(firstMessageByLocalId.values());
        const contentByLocalId = new Map(uniqueMessages.map((message) => [message.localId, message.content]));

        const txResult = await db.$transaction(async (tx) => {
            const localIds = uniqueMessages.map((message) => message.localId);
            const existing = await tx.sessionMessage.findMany({
                where: {
                    sessionId,
                    localId: { in: localIds }
                },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    sentBy: true,
                    sentByName: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            const existingByLocalId = new Map<string, Omit<SelectedMessage, 'content'>>();
            for (const message of existing) {
                if (message.localId) {
                    existingByLocalId.set(message.localId, message);
                }
            }

            const newMessages = uniqueMessages.filter((message) => !existingByLocalId.has(message.localId));
            const seqs = await allocateSessionSeqBatch(sessionId, newMessages.length, tx);

            const createdMessages: Array<SendResponseMessage & { trackCliDelivery: boolean; shouldTrackCliDelivery: boolean }> = [];
            for (let i = 0; i < newMessages.length; i += 1) {
                const message = newMessages[i];
                const shouldTrackCliDelivery = message.trackCliDelivery && ownerHasReceiptCapableCli;
                const createdMessage = await tx.sessionMessage.create({
                    data: {
                        sessionId,
                        seq: seqs[i],
                        content: {
                            t: 'encrypted',
                            c: message.content
                        },
                        localId: message.localId,
                        sentBy: userId,
                        sentByName,
                    },
                    select: {
                        id: true,
                        seq: true,
                        content: true,
                        localId: true,
                        sentBy: true,
                        sentByName: true,
                        createdAt: true,
                        updatedAt: true
                    }
                });
                if (shouldTrackCliDelivery) {
                    await tx.sessionMessageDeliveryIssue.create({
                        data: {
                            sessionMessageId: createdMessage.id,
                            status: 'waiting'
                        }
                    });
                }
                createdMessages.push({
                    ...createdMessage,
                    trackCliDelivery: message.trackCliDelivery,
                    shouldTrackCliDelivery
                });
            }

            const responseMessages = [...existing, ...createdMessages].sort((a, b) => a.seq - b.seq);

            return {
                responseMessages,
                createdMessages
            };
        });

        for (const message of txResult.createdMessages) {
            const content = message.localId ? contentByLocalId.get(message.localId) : null;
            if (!content) {
                continue;
            }

            const payloadMessage = {
                ...message,
                content: { t: 'encrypted', c: content }
            };

            const emitResult = await eventRouter.emitToSessionSubscribers({
                ownerId,
                sessionId,
                buildPayload: (_uid, seq) => buildNewMessageUpdate(payloadMessage, sessionId, seq, randomKeyNaked(12)),
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });

            if (emitResult.ownerDelivery.sessionScoped === 0) {
                if (message.seq === 1) {
                    void (async () => {
                        let replayed = false;
                        try {
                            replayed = await replayFirstMessageToCliWhenConnected({
                                ownerId,
                                sessionId,
                                message: payloadMessage
                            });
                        } catch (error) {
                            log({
                                module: "session-message",
                                level: "error",
                                ownerId,
                                sessionId,
                                messageId: message.id,
                                error: error instanceof Error ? error.message : String(error)
                            }, "Failed to replay first message to CLI");
                        }

                        if (!replayed && message.shouldTrackCliDelivery) {
                            try {
                                await markNoCliConnectionDeliveryIssue({
                                    ownerId,
                                    sessionId,
                                    messageId: message.id,
                                    localId: message.localId ?? null
                                });
                            } catch (error) {
                                log({
                                    module: "session-message",
                                    level: "error",
                                    ownerId,
                                    sessionId,
                                    messageId: message.id,
                                    error: error instanceof Error ? error.message : String(error)
                                }, "Failed to persist no_cli_connection delivery issue");
                            }
                        }
                    })();
                } else if (message.shouldTrackCliDelivery) {
                    await markNoCliConnectionDeliveryIssue({
                        ownerId,
                        sessionId,
                        messageId: message.id,
                        localId: message.localId ?? null
                    });
                }
            }
        }

        return reply.send({
            messages: txResult.responseMessages.map(toSendResponseMessage)
        });
    });
}

import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch, allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";

const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100)
});

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        content: z.string(),
        localId: z.string().min(1)
    })).min(1).max(100)
});

type SelectedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function toResponseMessage(message: SelectedMessage) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function toSendResponseMessage(message: Omit<SelectedMessage, "content">) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
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
        const { after_seq, limit } = request.query;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: {
                sessionId,
                seq: { gt: after_seq }
            },
            orderBy: { seq: 'asc' },
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                content: true,
                localId: true,
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

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const firstMessageByLocalId = new Map<string, { localId: string; content: string }>();
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

            const createdMessages: Omit<SelectedMessage, 'content'>[] = [];
            for (let i = 0; i < newMessages.length; i += 1) {
                const message = newMessages[i];
                const createdMessage = await tx.sessionMessage.create({
                    data: {
                        sessionId,
                        seq: seqs[i],
                        content: {
                            t: 'encrypted',
                            c: message.content
                        },
                        localId: message.localId
                    },
                    select: {
                        id: true,
                        seq: true,
                        content: true,
                        localId: true,
                        createdAt: true,
                        updatedAt: true
                    }
                });
                createdMessages.push(createdMessage);
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
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildNewMessageUpdate({
                ...message,
                content: {
                    t: 'encrypted',
                    c: content
                }
            }, sessionId, updSeq, randomKeyNaked(12));

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        }

        return reply.send({
            messages: txResult.responseMessages.map(toSendResponseMessage)
        });
    });
}

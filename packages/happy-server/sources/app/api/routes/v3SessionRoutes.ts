import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import { allocateSessionSeqBatch, allocateUserSeqBatch } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";

// Pagination contract:
//   - after_seq=N  → forward sync: messages with seq > N, ordered ASC.
//                    Used by the client to pull anything new since the highest
//                    seq it has already seen.
//   - before_seq=N → backward paging: messages with seq < N, ordered DESC.
//                    Used by the client to lazy-load older history when the
//                    user scrolls up, so opening a long session does not block
//                    on fetching the entire history first.
// The two are mutually exclusive. With neither, the route defaults to
// `after_seq=0` (forward from the start) for backward compatibility.
const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
}).refine(
    (data) => !(data.after_seq !== undefined && data.before_seq !== undefined),
    { message: "after_seq and before_seq are mutually exclusive" }
);

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
        const { after_seq, before_seq, limit } = request.query;

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

        // Backward direction is opt-in via `before_seq`; everything else (no
        // params, or explicit `after_seq`) keeps the legacy forward semantics.
        const isBackward = before_seq !== undefined;
        const where = isBackward
            ? { sessionId, seq: { lt: before_seq } }
            : { sessionId, seq: { gt: after_seq ?? 0 } };
        const orderBy = isBackward
            ? { seq: 'desc' as const }
            : { seq: 'asc' as const };

        const messages = await db.sessionMessage.findMany({
            where,
            orderBy,
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

        const responseMessages = await inTx(async (tx) => {
            // Lock the per-session seq row before checking localIds. This makes
            // concurrent retries for the same batch observe committed rows
            // before allocating new seq values.
            await tx.session.update({
                where: { id: sessionId },
                data: { seq: { increment: 0 } },
                select: { id: true }
            });

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

            const createdMessages = newMessages.length > 0
                ? await tx.sessionMessage.createManyAndReturn({
                    data: newMessages.map((message, index) => ({
                        sessionId,
                        seq: seqs[index],
                        content: {
                            t: 'encrypted',
                            c: message.content
                        },
                        localId: message.localId
                    })),
                    skipDuplicates: true,
                    select: {
                        id: true,
                        seq: true,
                        localId: true,
                        createdAt: true,
                        updatedAt: true
                    }
                })
                : [];
            createdMessages.sort((a, b) => a.seq - b.seq);

            // Re-read every requested localId so a concurrent retry returns the
            // same idempotent acknowledgement even if skipDuplicates handled a
            // uniqueness race inside createManyAndReturn.
            const acknowledgedMessages = await tx.sessionMessage.findMany({
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
            acknowledgedMessages.sort((a, b) => a.seq - b.seq);

            // Allocate the account update seq inside the same transaction as
            // the message rows. Only the non-transactional socket delivery is
            // deferred through afterTx.
            const newestCreatedMessage = createdMessages.at(-1);
            if (newestCreatedMessage) {
                const content = newestCreatedMessage.localId
                    ? contentByLocalId.get(newestCreatedMessage.localId)
                    : null;
                if (content) {
                    const [updateSeq] = await allocateUserSeqBatch(userId, 1, tx);
                    const updatePayload = buildNewMessageUpdate({
                        ...newestCreatedMessage,
                        content: {
                            t: 'encrypted',
                            c: content
                        }
                    }, sessionId, updateSeq, randomKeyNaked(12));

                    afterTx(tx, () => {
                        eventRouter.emitUpdate({
                            userId,
                            payload: updatePayload,
                            recipientFilter: { type: 'all-interested-in-session', sessionId }
                        });
                    });
                }
            }

            return acknowledgedMessages;
        });

        return reply.send({
            messages: responseMessages.map(toSendResponseMessage)
        });
    });
}

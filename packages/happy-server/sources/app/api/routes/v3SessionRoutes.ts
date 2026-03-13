import {
    buildPendingMessageDeleteEphemeral,
    buildPendingMessageUpsertEphemeral,
    eventRouter,
} from "@/app/events/eventRouter";
import { canSendMessages } from "@/app/share/accessControl";
import { isSessionBusy, markDispatched } from "@/app/presence/sessionTurnRuntime";
import {
    deletePendingMessage,
    enqueuePendingMessage,
    findPendingMessageById,
    listPendingMessages,
    pinPendingMessage,
    type PendingMessageRecord,
} from "@/app/session/pendingMessageService";
import { dispatchNextPendingIfPossible } from "@/app/session/pendingMessageAutoDispatch";
import { dispatchSessionMessage } from "@/app/session/sessionMessageDispatch";
import { db } from "@/storage/db";
import { z } from "zod";
import { type Fastify } from "../types";
import { scheduleFirstMessageReplay } from "./firstMessageReplay";

const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
});

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        content: z.string(),
        localId: z.string().min(1),
        trackCliDelivery: z.boolean().optional().default(false),
    })).min(1).max(200),
});

const sendMessageBodySchema = z.object({
    content: z.string(),
    localId: z.string().min(1),
    trackCliDelivery: z.boolean().optional().default(false),
});

const pendingMessageParamsSchema = z.object({
    sessionId: z.string(),
    pendingId: z.string(),
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

type ExistingSendMessage = {
    id: string;
    seq: number;
    localId: string | null;
    sentBy: string | null;
    sentByName: string | null;
    createdAt: Date;
    updatedAt: Date;
};

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
                reason: message.deliveryIssue.reason,
            }
            : undefined,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
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
        updatedAt: message.updatedAt.getTime(),
    };
}

function toPendingResponseMessage(message: PendingMessageRecord) {
    return {
        id: message.id,
        localId: message.localId,
        content: message.content,
        sentBy: message.sentBy,
        sentByName: message.sentByName,
        trackCliDelivery: message.trackCliDelivery,
        pinnedAt: message.pinnedAt ? message.pinnedAt.getTime() : null,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime(),
    };
}

function extractEncryptedText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (
        content &&
        typeof content === "object" &&
        "t" in content &&
        "c" in content &&
        (content as { t?: unknown }).t === "encrypted" &&
        typeof (content as { c?: unknown }).c === "string"
    ) {
        return (content as { c: string }).c;
    }

    return "";
}

async function getSessionOwnerId(sessionId: string): Promise<string | null> {
    const session = await db.session.findUnique({
        where: { id: sessionId },
        select: { accountId: true },
    });

    return session?.accountId ?? null;
}

async function getSenderName(userId: string): Promise<string | null> {
    const senderAccount = await db.account.findUnique({
        where: { id: userId },
        select: { firstName: true, username: true },
    });

    return senderAccount?.firstName || senderAccount?.username || null;
}

async function findExistingSentMessageByLocalId(sessionId: string, localId: string): Promise<ExistingSendMessage | null> {
    const existingMessages = await db.sessionMessage.findMany({
        where: {
            sessionId,
            localId: { in: [localId] },
        },
        take: 1,
        select: {
            id: true,
            seq: true,
            localId: true,
            sentBy: true,
            sentByName: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return (existingMessages[0] as ExistingSendMessage | undefined) ?? null;
}

async function emitPendingUpsert(ownerId: string, sessionId: string, pending: PendingMessageRecord) {
    await eventRouter.emitEphemeralToSessionSubscribers({
        ownerId,
        sessionId,
        payload: buildPendingMessageUpsertEphemeral(sessionId, pending),
        recipientFilter: { type: "all-interested-in-session", sessionId },
    });
}

async function emitPendingDelete(ownerId: string, sessionId: string, pendingId: string) {
    await eventRouter.emitEphemeralToSessionSubscribers({
        ownerId,
        sessionId,
        payload: buildPendingMessageDeleteEphemeral(sessionId, pendingId),
        recipientFilter: { type: "all-interested-in-session", sessionId },
    });
}

export function resolveSendMode(input: { hasPending: boolean; isThinking: boolean }): "queued" | "sent" {
    if (input.hasPending || input.isThinking) {
        return "queued";
    }

    return "sent";
}

export function v3SessionRoutes(app: Fastify) {
    app.get("/v3/sessions/:sessionId/messages", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            querystring: getMessagesQuerySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit } = request.query;

        if (after_seq !== undefined && before_seq !== undefined) {
            return reply.code(400).send({ error: "Cannot specify both after_seq and before_seq" });
        }

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                OR: [
                    { accountId: userId },
                    { shares: { some: { sharedWithUserId: userId } } },
                ],
            },
            select: { id: true },
        });

        if (!session) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const isForward = after_seq !== undefined;
        const seqFilter = after_seq !== undefined
            ? { gt: after_seq }
            : before_seq !== undefined
                ? { lt: before_seq }
                : undefined;
        const orderBy = isForward ? "asc" as const : "desc" as const;

        const messages = await db.sessionMessage.findMany({
            where: {
                sessionId,
                ...(seqFilter ? { seq: seqFilter } : {}),
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
                        reason: true,
                    },
                },
                createdAt: true,
                updatedAt: true,
            },
        });

        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;

        return reply.send({
            messages: page.map(toResponseMessage),
            hasMore,
        });
    });

    app.post("/v3/sessions/:sessionId/messages", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: sendMessagesBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { messages } = request.body;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const ownerId = await getSessionOwnerId(sessionId);
        if (!ownerId) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const sentByName = await getSenderName(userId);

        const firstMessageByLocalId = new Map<string, { localId: string; content: string; trackCliDelivery: boolean }>();
        for (const message of messages) {
            if (!firstMessageByLocalId.has(message.localId)) {
                firstMessageByLocalId.set(message.localId, message);
            }
        }

        const uniqueMessages = Array.from(firstMessageByLocalId.values());
        const existingMessages = await db.sessionMessage.findMany({
            where: {
                sessionId,
                localId: { in: uniqueMessages.map((message) => message.localId) },
            },
            select: {
                id: true,
                seq: true,
                localId: true,
                sentBy: true,
                sentByName: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        const existingByLocalId = new Map<string, ExistingSendMessage>();
        for (const message of existingMessages) {
            if (message.localId) {
                existingByLocalId.set(message.localId, message as ExistingSendMessage);
            }
        }

        const responseMessages: ExistingSendMessage[] = [];
        for (const message of uniqueMessages) {
            const existing = existingByLocalId.get(message.localId);
            if (existing) {
                responseMessages.push(existing);
                continue;
            }

            const dispatched = await dispatchSessionMessage({
                ownerId,
                sessionId,
                content: message.content,
                localId: message.localId,
                sentBy: userId,
                sentByName,
                trackCliDelivery: message.trackCliDelivery,
            });

            if (dispatched.message.seq === 1 && dispatched.ownerSessionScopedDeliveries === 0) {
                scheduleFirstMessageReplay({
                    ownerId,
                    sessionId,
                    message: {
                        ...dispatched.message,
                        content: {
                            t: "encrypted",
                            c: message.content,
                        },
                    },
                });
            }

            responseMessages.push(dispatched.message);
        }

        responseMessages.sort((a, b) => a.seq - b.seq);

        return reply.send({
            messages: responseMessages.map(toSendResponseMessage),
        });
    });

    app.get("/v3/sessions/:sessionId/pending-messages", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const messages = await listPendingMessages(sessionId);
        return reply.send({
            messages: messages.map(toPendingResponseMessage),
        });
    });

    app.post("/v3/sessions/:sessionId/send", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: sendMessageBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { localId, content, trackCliDelivery } = request.body;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const ownerId = await getSessionOwnerId(sessionId);
        if (!ownerId) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const existingSentMessage = await findExistingSentMessageByLocalId(sessionId, localId);
        if (existingSentMessage) {
            return reply.send({
                mode: "sent",
                message: toSendResponseMessage(existingSentMessage),
            });
        }

        const sentByName = await getSenderName(userId);

        const hasPending = !!await db.sessionPendingMessage.findFirst({
            where: {
                sessionId,
            },
            select: {
                id: true,
            },
        });

        const mode = resolveSendMode({
            hasPending,
            isThinking: isSessionBusy(sessionId),
        });

        if (mode === "queued") {
            const { message: pendingMessage, created } = await enqueuePendingMessage({
                sessionId,
                localId,
                content,
                sentBy: userId,
                sentByName,
                trackCliDelivery,
            });

            if (created) {
                await emitPendingUpsert(ownerId, sessionId, pendingMessage);
            }

            await dispatchNextPendingIfPossible({
                ownerId,
                sessionId,
            });

            return reply.send({
                mode,
                pending: toPendingResponseMessage(pendingMessage),
            });
        }

        const dispatched = await dispatchSessionMessage({
            ownerId,
            sessionId,
            content,
            localId,
            sentBy: userId,
            sentByName,
            trackCliDelivery,
        });

        if (dispatched.message.seq === 1 && dispatched.ownerSessionScopedDeliveries === 0) {
            scheduleFirstMessageReplay({
                ownerId,
                sessionId,
                message: {
                    ...dispatched.message,
                    content: {
                        t: "encrypted",
                        c: content,
                    },
                },
            });
        }

        markDispatched(sessionId);

        return reply.send({
            mode,
            message: toSendResponseMessage(dispatched.message),
        });
    });

    app.post("/v3/sessions/:sessionId/pending-messages/:pendingId/pin", {
        preHandler: app.authenticate,
        schema: {
            params: pendingMessageParamsSchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, pendingId } = request.params;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const ownerId = await getSessionOwnerId(sessionId);
        if (!ownerId) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const pending = await pinPendingMessage(sessionId, pendingId);
        if (!pending) {
            return reply.code(404).send({ error: "Pending message not found" });
        }

        await emitPendingUpsert(ownerId, sessionId, pending);

        return reply.send({
            message: toPendingResponseMessage(pending),
        });
    });

    app.delete("/v3/sessions/:sessionId/pending-messages/:pendingId", {
        preHandler: app.authenticate,
        schema: {
            params: pendingMessageParamsSchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, pendingId } = request.params;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const ownerId = await getSessionOwnerId(sessionId);
        if (!ownerId) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const pending = await deletePendingMessage(sessionId, pendingId);
        if (!pending) {
            return reply.code(404).send({ error: "Pending message not found" });
        }

        await emitPendingDelete(ownerId, sessionId, pending.id);

        return reply.send({
            ok: true,
            pendingId: pending.id,
        });
    });

    app.post("/v3/sessions/:sessionId/pending-messages/:pendingId/send-now", {
        preHandler: app.authenticate,
        schema: {
            params: pendingMessageParamsSchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, pendingId } = request.params;

        if (!await canSendMessages(userId, sessionId)) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const ownerId = await getSessionOwnerId(sessionId);
        if (!ownerId) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const pending = await findPendingMessageById(sessionId, pendingId);
        if (!pending) {
            return reply.code(404).send({ error: "Pending message not found" });
        }

        await deletePendingMessage(sessionId, pendingId);
        await emitPendingDelete(ownerId, sessionId, pending.id);

        const dispatched = await dispatchSessionMessage({
            ownerId,
            sessionId,
            content: extractEncryptedText(pending.content),
            localId: pending.localId,
            sentBy: pending.sentBy,
            sentByName: pending.sentByName,
            trackCliDelivery: pending.trackCliDelivery,
        });

        if (dispatched.message.seq === 1 && dispatched.ownerSessionScopedDeliveries === 0) {
            scheduleFirstMessageReplay({
                ownerId,
                sessionId,
                message: {
                    ...dispatched.message,
                    content: pending.content,
                },
            });
        }

        markDispatched(sessionId);

        return reply.send({
            mode: "sent",
            message: toSendResponseMessage(dispatched.message),
        });
    });
}

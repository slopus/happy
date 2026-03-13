import { buildMessageDeliveryErrorEphemeral, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

export type DispatchSessionMessageParams = {
    ownerId: string;
    sessionId: string;
    content: string;
    localId: string;
    sentBy: string | null;
    sentByName: string | null;
    trackCliDelivery: boolean;
};

export type DispatchedSessionMessage = {
    id: string;
    seq: number;
    localId: string | null;
    sentBy: string | null;
    sentByName: string | null;
    createdAt: Date;
    updatedAt: Date;
};

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

export async function dispatchSessionMessage(params: DispatchSessionMessageParams): Promise<{
    message: DispatchedSessionMessage;
    ownerSessionScopedDeliveries: number;
}> {
    const shouldTrackCliDelivery = params.trackCliDelivery
        && hasReceiptCapableCliConnection(params.ownerId, params.sessionId);

    const createdMessage = await db.$transaction(async (tx) => {
        const [seq] = await allocateSessionSeqBatch(params.sessionId, 1, tx);
        const created = await tx.sessionMessage.create({
            data: {
                sessionId: params.sessionId,
                seq,
                content: {
                    t: 'encrypted',
                    c: params.content,
                },
                localId: params.localId,
                sentBy: params.sentBy,
                sentByName: params.sentByName,
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

        if (shouldTrackCliDelivery) {
            await tx.sessionMessageDeliveryIssue.create({
                data: {
                    sessionMessageId: created.id,
                    status: 'waiting',
                },
            });
        }

        return created;
    });

    const payloadMessage = {
        ...createdMessage,
        content: { t: 'encrypted', c: params.content },
    };

    const emitResult = await eventRouter.emitToSessionSubscribers({
        ownerId: params.ownerId,
        sessionId: params.sessionId,
        buildPayload: (_uid, seq) => buildNewMessageUpdate(payloadMessage, params.sessionId, seq, randomKeyNaked(12)),
        recipientFilter: { type: 'all-interested-in-session', sessionId: params.sessionId },
    });

    if (params.trackCliDelivery && emitResult.ownerDelivery.sessionScoped === 0) {
        await db.sessionMessageDeliveryIssue.upsert({
            where: {
                sessionMessageId: createdMessage.id,
            },
            create: {
                sessionMessageId: createdMessage.id,
                status: 'error',
                reason: 'no_cli_connection',
            },
            update: {
                status: 'error',
                reason: 'no_cli_connection',
            },
        });

        await eventRouter.emitEphemeralToSessionSubscribers({
            ownerId: params.ownerId,
            sessionId: params.sessionId,
            payload: buildMessageDeliveryErrorEphemeral(params.sessionId, createdMessage.id, createdMessage.localId ?? null, 'no_cli_connection'),
            recipientFilter: { type: 'all-interested-in-session', sessionId: params.sessionId },
        });
    }

    return {
        message: createdMessage,
        ownerSessionScopedDeliveries: emitResult.ownerDelivery.sessionScoped,
    };
}

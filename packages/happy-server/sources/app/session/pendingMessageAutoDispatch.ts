import { buildPendingMessageDeleteEphemeral, eventRouter } from "@/app/events/eventRouter";
import {
    beginDispatch,
    canDispatch,
    finishDispatch,
    markDispatched,
} from "@/app/presence/sessionTurnRuntime";
import { scheduleFirstMessageReplay } from "@/app/api/routes/firstMessageReplay";
import { dispatchSessionMessage } from "@/app/session/sessionMessageDispatch";
import { takeNextPendingMessageForDispatch } from "@/app/session/pendingMessageService";

function extractEncryptedText(content: unknown): string {
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

export async function dispatchNextPendingIfPossible(params: {
    ownerId: string;
    sessionId: string;
}): Promise<{ dispatched: boolean; pendingId?: string; messageId?: string }> {
    if (!canDispatch(params.sessionId)) {
        return { dispatched: false };
    }

    if (!beginDispatch(params.sessionId)) {
        return { dispatched: false };
    }

    try {
        // Wait briefly so the AI's final response (which may still be in-flight)
        // arrives at the app before the next pending message is dispatched.
        await new Promise(r => setTimeout(r, 1000));

        const pending = await takeNextPendingMessageForDispatch(params.sessionId);
        if (!pending) {
            return { dispatched: false };
        }

        await eventRouter.emitEphemeralToSessionSubscribers({
            ownerId: params.ownerId,
            sessionId: params.sessionId,
            payload: buildPendingMessageDeleteEphemeral(params.sessionId, pending.id),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });

        const content = extractEncryptedText(pending.content);
        const dispatched = await dispatchSessionMessage({
            ownerId: params.ownerId,
            sessionId: params.sessionId,
            content,
            localId: pending.localId,
            sentBy: pending.sentBy,
            sentByName: pending.sentByName,
            trackCliDelivery: pending.trackCliDelivery,
        });

        markDispatched(params.sessionId);

        if (dispatched.message.seq === 1 && dispatched.ownerSessionScopedDeliveries === 0) {
            scheduleFirstMessageReplay({
                ownerId: params.ownerId,
                sessionId: params.sessionId,
                message: {
                    ...dispatched.message,
                    content: pending.content,
                },
            });
        }

        return {
            dispatched: true,
            pendingId: pending.id,
            messageId: dispatched.message.id,
        };
    } finally {
        finishDispatch(params.sessionId);
    }
}

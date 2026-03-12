import { buildMessageDeliveryErrorEphemeral, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";

export const MESSAGE_DELIVERY_ACK_TIMEOUT_MS = 60_000;
export const MESSAGE_DELIVERY_SCAN_INTERVAL_MS = 10_000;

export async function markTimedOutDeliveryIssues(nowMs: number = Date.now()) {
    const issues = await db.sessionMessageDeliveryIssue.findMany({
        where: {
            status: 'waiting'
        },
        select: {
            sessionMessageId: true,
            sessionMessage: {
                select: {
                    id: true,
                    localId: true,
                    sessionId: true,
                    createdAt: true,
                    session: {
                        select: {
                            accountId: true
                        }
                    }
                }
            }
        }
    });

    const timeoutBefore = nowMs - MESSAGE_DELIVERY_ACK_TIMEOUT_MS;

    for (const issue of issues) {
        if (!issue.sessionMessage?.session) {
            continue;
        }
        if (issue.sessionMessage.createdAt.getTime() > timeoutBefore) {
            continue;
        }

        const updated = await db.sessionMessageDeliveryIssue.updateMany({
            where: {
                sessionMessageId: issue.sessionMessageId,
                status: 'waiting'
            },
            data: {
                status: 'error',
                reason: 'ack_timeout'
            }
        });

        if (updated.count === 0) {
            continue;
        }

        await eventRouter.emitEphemeralToSessionSubscribers({
            ownerId: issue.sessionMessage.session.accountId,
            sessionId: issue.sessionMessage.sessionId,
            payload: buildMessageDeliveryErrorEphemeral(
                issue.sessionMessage.sessionId,
                issue.sessionMessage.id,
                issue.sessionMessage.localId,
                'ack_timeout'
            ),
            recipientFilter: {
                type: 'all-interested-in-session',
                sessionId: issue.sessionMessage.sessionId
            }
        });
    }
}

export function startMessageDeliveryTimeoutWorker() {
    forever('message-delivery-timeout', async () => {
        while (true) {
            await markTimedOutDeliveryIssues();
            await delay(MESSAGE_DELIVERY_SCAN_INTERVAL_MS, shutdownSignal);
        }
    });
}

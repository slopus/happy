import { getMetricsLabelsFromSocket, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { ClientConnection } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { Socket } from "socket.io";
import { z } from "zod";

const sidsSchema = z.object({ sids: z.array(z.string()).min(1).max(500) });

/**
 * Lets a daemon receive session updates on its single machine-scoped socket
 * instead of opening one session-scoped socket per session. Subscribing joins
 * the same room a session-scoped socket joins at connect time, so routing and
 * skip-sender behave identically.
 *
 * Subscriptions are socket rooms: they vanish on disconnect and the client
 * must resubscribe after every reconnect. Servers without this handler never
 * ack, so clients detect support by ack timeout and fall back.
 */
export function sessionSubscribeHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);
    // Subscribe awaits an ownership query before joining; without the lock an
    // unsubscribe sent right after could ack first and then be undone by it.
    const subscriptionLock = new AsyncLock();

    socket.on('session-subscribe', (data: any, callback: (response: any) => void) => subscriptionLock.inLock(async () => {
        try {
            websocketEventsCounter.inc({ event_type: 'session-subscribe', ...labels });
            if (connection.connectionType !== 'machine-scoped') {
                callback?.({ result: 'error', reason: 'unsupported-client' });
                return;
            }
            const parsed = sidsSchema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: 'error', reason: 'invalid' });
                return;
            }
            const sids = [...new Set(parsed.data.sids)];

            const owned = await db.session.findMany({
                where: { accountId: userId, id: { in: sids } },
                select: { id: true }
            });
            const ownedIds = new Set(owned.map((s) => s.id));
            const subscribed = sids.filter((sid) => ownedIds.has(sid));
            const missing = sids.filter((sid) => !ownedIds.has(sid));
            if (subscribed.length > 0) {
                await socket.join(subscribed.map((sid) => `user:${userId}:session:${sid}`));
            }

            log({ module: 'websocket' }, `session-subscribe: machine ${connection.machineId}, subscribed ${subscribed.length}, missing ${missing.length}`);
            callback?.({ result: 'success', subscribed, missing });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-subscribe: ${error}`);
            callback?.({ result: 'error', reason: 'internal' });
        }
    }));

    socket.on('session-unsubscribe', (data: any, callback: (response: any) => void) => subscriptionLock.inLock(async () => {
        try {
            websocketEventsCounter.inc({ event_type: 'session-unsubscribe', ...labels });
            if (connection.connectionType !== 'machine-scoped') {
                callback?.({ result: 'error', reason: 'unsupported-client' });
                return;
            }
            const parsed = sidsSchema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: 'error', reason: 'invalid' });
                return;
            }
            for (const sid of new Set(parsed.data.sids)) {
                await socket.leave(`user:${userId}:session:${sid}`);
            }
            callback?.({ result: 'success' });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-unsubscribe: ${error}`);
            callback?.({ result: 'error', reason: 'internal' });
        }
    }));
}

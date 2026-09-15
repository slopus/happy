import type { Socket } from 'socket.io';
import { SessionStreamEnvelopeSchema, SESSION_STREAM_MAX_CIPHERTEXT_LENGTH, type SessionStreamEnvelope } from '@slopus/happy-wire';
import { eventRouter, type ClientConnection } from '@/app/events/eventRouter';
import { db } from '@/storage/db';

/** Relay bounded ciphertext previews from the exact authenticated session owner.
 * No sequence allocation, history writes, replay queue or plaintext handling.
 */
export function sessionStreamHandler(userId: string, socket: Socket, connection: ClientConnection): void {
    let queued: SessionStreamEnvelope[] = [];
    let queuedBytes = 0;
    let draining: Promise<void> | null = null;
    socket.on('disconnect', () => { queued = []; queuedBytes = 0; });
    socket.on('session-stream', (data: unknown) => {
        if (connection.connectionType !== 'session-scoped' || connection.userId !== userId) return;
        const parsed = SessionStreamEnvelopeSchema.safeParse(data);
        if (!parsed.success || parsed.data.sid !== connection.sessionId || !socket.connected) return;
        queued.push(parsed.data);
        queuedBytes += parsed.data.content.c.length;
        // Keep the newest cumulative snapshots during a slow DB read without
        // retaining an async callback (and full payload) for every notification.
        while (queued.length > 8 || queuedBytes > SESSION_STREAM_MAX_CIPHERTEXT_LENGTH) {
            queuedBytes -= queued.shift()!.content.c.length;
        }
        if (draining) return draining;
        draining = (async () => {
            try {
                const session = await db.session.findUnique({
                    where: { id: connection.sessionId, accountId: userId }, select: { id: true },
                });
                if (session && socket.connected) {
                    for (const payload of queued) eventRouter.emitSessionStream({ userId, payload, sender: connection });
                }
            } catch {
                // A transient preview can be dropped; the durable final recovers it.
            } finally {
                queued = [];
                queuedBytes = 0;
                draining = null;
            }
        })();
        return draining;
    });
}

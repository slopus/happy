import { sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { updateThinkingState } from "@/app/presence/sessionTurnRuntime";
import { dispatchNextPendingIfPossible } from "@/app/session/pendingMessageAutoDispatch";
import { buildMessageDeliveryClearedEphemeral, buildMessageDeliveryErrorEphemeral, buildMessageErrorEphemeral, buildMessageSyncingEphemeral, buildMessageSyncedEphemeral, buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import { delay } from "@/utils/delay";

/**
 * Check if there's an active CLI (session-scoped) connection for a session.
 */
function hasCliConnection(userId: string, sessionId: string): boolean {
    const connections = eventRouter.getConnections(userId);
    if (!connections) return false;
    return Array.from(connections).some(
        conn => conn.connectionType === 'session-scoped' && conn.sessionId === sessionId
    );
}

/**
 * Wait for CLI connection with polling.
 * Returns true if CLI is connected, false if still disconnected after timeout.
 */
async function waitForCliConnection(userId: string, sessionId: string, maxWaitMs: number = 8000, intervalMs: number = 2000): Promise<boolean> {
    if (hasCliConnection(userId, sessionId)) {
        return true;
    }

    const maxAttempts = Math.ceil(maxWaitMs / intervalMs);
    for (let i = 0; i < maxAttempts; i++) {
        await delay(intervalMs);
        if (hasCliConnection(userId, sessionId)) {
            return true;
        }
    }

    return false;
}

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata
            const { count } = await db.session.updateMany({
                where: { id: sid, metadataVersion: expectedVersion },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Generate session metadata update and broadcast to owner + shared users
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            await eventRouter.emitToSessionSubscribers({
                ownerId: userId,
                sessionId: sid,
                buildPayload: (_uid, seq) => buildUpdateSessionUpdate(sid, seq, randomKeyNaked(12), metadataUpdate),
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                }
            });
            if (!session) {
                callback({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { id: sid, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Generate session agent state update and broadcast to owner + shared users
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            await eventRouter.emitToSessionSubscribers({
                ownerId: userId,
                sessionId: sid,
                buildPayload: (_uid, seq) => buildUpdateSessionUpdate(sid, seq, randomKeyNaked(12), undefined, agentStateUpdate),
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive' });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            const thinkingState = updateThinkingState(sid, !!thinking, t);
            if (thinkingState.turnEnded) {
                await dispatchNextPendingIfPossible({
                    ownerId: userId,
                    sessionId: sid,
                });
            }

            // Emit session activity update to owner and shared users
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeralToSessionSubscribers({
                ownerId: userId,
                sessionId: sid,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    socket.on('message-receipt', async (data: any) => {
        try {
            const sid = typeof data?.sid === 'string' ? data.sid : null;
            const messageId = typeof data?.messageId === 'string' ? data.messageId : null;
            const localId = typeof data?.localId === 'string' ? data.localId : null;
            const ok = typeof data?.ok === 'boolean' ? data.ok : null;
            const error = typeof data?.error === 'string' ? data.error : null;

            if (!sid || ok === null || (!messageId && !localId)) {
                return;
            }

            if (connection.connectionType !== 'session-scoped' || connection.sessionId !== sid) {
                return;
            }

            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                },
                select: { id: true }
            });
            if (!session) {
                return;
            }

            const message = await db.sessionMessage.findFirst({
                where: {
                    sessionId: sid,
                    ...(messageId ? { id: messageId } : { localId: localId! })
                },
                select: {
                    id: true,
                    localId: true
                }
            });
            if (!message) {
                return;
            }

            if (ok) {
                await db.sessionMessageDeliveryIssue.deleteMany({
                    where: {
                        sessionMessageId: message.id
                    }
                });

                await eventRouter.emitEphemeralToSessionSubscribers({
                    ownerId: userId,
                    sessionId: sid,
                    payload: buildMessageDeliveryClearedEphemeral(sid, message.id, message.localId),
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
                });
                return;
            }

            const reason = error || 'unknown_error';
            await db.sessionMessageDeliveryIssue.upsert({
                where: {
                    sessionMessageId: message.id
                },
                create: {
                    sessionMessageId: message.id,
                    status: 'error',
                    reason
                },
                update: {
                    status: 'error',
                    reason
                }
            });

            await eventRouter.emitEphemeralToSessionSubscribers({
                ownerId: userId,
                sessionId: sid,
                payload: buildMessageDeliveryErrorEphemeral(sid, message.id, message.localId, reason),
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in message-receipt: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message-batch', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            let batchSessionId: string | null = null;
            let batchCount = 0;
            try {
                websocketEventsCounter.inc({ event_type: 'message-batch' });
                const { sid, messages, mode } = data || {};
                batchSessionId = typeof sid === 'string' ? sid : null;

                if (!sid || !Array.isArray(messages)) {
                    if (callback) {
                        callback({ result: 'error' });
                    }
                    return;
                }

                // Only allow session-scoped connections to batch replace
                if (connection.connectionType !== 'session-scoped') {
                    if (callback) {
                        callback({ result: 'error' });
                    }
                    return;
                }

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    if (callback) {
                        callback({ result: 'error' });
                    }
                    return;
                }

                const sanitized = messages
                    .filter((item: any) => item && typeof item.message === 'string')
                    .map((item: any) => ({
                        message: item.message as string,
                        localId: typeof item.localId === 'string' ? item.localId : null
                    }));

                const count = sanitized.length;
                batchCount = count;
                if (count === 0) {
                    if (callback) {
                        callback({ result: 'success', inserted: 0 });
                    }
                    return;
                }

                // Notify clients that syncing has started
                eventRouter.emitEphemeral({
                    userId,
                    payload: buildMessageSyncingEphemeral(sid, count),
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
                });

                const now = Date.now();
                await db.$transaction(async (tx) => {
                    if (mode === 'replace') {
                        // Only delete previous backfill messages (identified by localId prefix),
                        // not user/agent messages that may have arrived concurrently.
                        const backfillLocalIds = sanitized
                            .map(item => item.localId)
                            .filter((id): id is string => id !== null);
                        const prefixes = new Set<string>();
                        for (const id of backfillLocalIds) {
                            // Extract prefix like "claude-log:", "codex-log:", "gemini-log:"
                            const colonIdx = id.indexOf(':');
                            if (colonIdx > 0) {
                                prefixes.add(id.substring(0, colonIdx + 1));
                            }
                        }
                        if (prefixes.size > 0) {
                            await tx.sessionMessage.deleteMany({
                                where: {
                                    sessionId: sid,
                                    OR: [...prefixes].map(prefix => ({
                                        localId: { startsWith: prefix }
                                    }))
                                }
                            });
                        }
                    }

                    const updatedSession = await tx.session.update({
                        where: { id: sid },
                        select: { seq: true },
                        data: { seq: { increment: count } }
                    });

                    const endSeq = updatedSession.seq;
                    const startSeq = endSeq - count + 1;
                    const baseTime = now - count;

                    const rows = sanitized.map((item, index) => ({
                        sessionId: sid,
                        seq: startSeq + index,
                        content: {
                            t: 'encrypted',
                            c: item.message
                        } as PrismaJson.SessionMessageContent,
                        localId: item.localId,
                        createdAt: new Date(baseTime + index),
                        updatedAt: new Date(baseTime + index)
                    }));

                    await tx.sessionMessage.createMany({
                        data: rows,
                        skipDuplicates: true
                    });
                });

                // Notify clients that syncing has completed
                eventRouter.emitEphemeral({
                    userId,
                    payload: buildMessageSyncedEphemeral(sid, count),
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
                });

                if (callback) {
                    callback({ result: 'success', inserted: count });
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message-batch handler: ${error}`);
                if (batchSessionId) {
                    eventRouter.emitEphemeral({
                        userId,
                        payload: buildMessageErrorEphemeral(batchSessionId, 'message batch failed'),
                        recipientFilter: { type: 'all-interested-in-session', sessionId: batchSessionId }
                    });
                }
                if (callback) {
                    callback({ result: 'error' });
                }
            }
        });
    });
    socket.on('message', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const { sid, message, localId } = data;

                log({ module: 'websocket' }, `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${message.length} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`);

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    if (callback) {
                        callback({ result: 'error', error: 'Session not found' });
                    }
                    return;
                }

                // If message is from App (user-scoped), check if CLI is connected to receive it
                // This prevents "message lost" scenario when CLI process has died
                if (connection.connectionType === 'user-scoped') {
                    const cliConnected = await waitForCliConnection(userId, sid);
                    if (!cliConnected) {
                        log({ module: 'websocket' }, `No CLI connection for session ${sid} after waiting, returning error`);
                        if (callback) {
                            callback({ result: 'error', error: 'Session is offline' });
                        }
                        return;
                    }
                }

                let useLocalId = typeof localId === 'string' ? localId : null;

                // Create encrypted message
                const msgContent: PrismaJson.SessionMessageContent = {
                    t: 'encrypted',
                    c: message
                };

                // Resolve message seq
                const msgSeq = await allocateSessionSeq(sid);

                // Check if message already exists
                if (useLocalId) {
                    const existing = await db.sessionMessage.findFirst({
                        where: { sessionId: sid, localId: useLocalId }
                    });
                    if (existing) {
                        // Message already exists, return success with existing message info
                        if (callback) {
                            callback({ result: 'success', messageId: existing.id, seq: existing.seq });
                        }
                        return;
                    }
                }

                // Create message
                const msg = await db.sessionMessage.create({
                    data: {
                        sessionId: sid,
                        seq: msgSeq,
                        content: msgContent,
                        localId: useLocalId
                    }
                });

                // Emit new message update to owner + shared users
                await eventRouter.emitToSessionSubscribers({
                    ownerId: userId,
                    sessionId: sid,
                    buildPayload: (_uid, seq) => buildNewMessageUpdate(msg, sid, seq, randomKeyNaked(12)),
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });

                // Return success response
                if (callback) {
                    callback({ result: 'success', messageId: msg.id, seq: msg.seq });
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
                if (callback) {
                    callback({ result: 'error', error: error instanceof Error ? error.message : 'Unknown error' });
                }
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Update last active at
            await db.session.update({
                where: { id: sid },
                data: { lastActiveAt: new Date(t), active: false }
            });

            // Emit session activity update to owner and shared users
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeralToSessionSubscribers({
                ownerId: userId,
                sessionId: sid,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}

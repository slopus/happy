import { sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const getSessionParticipantUserIds = async (sessionId: string): Promise<string[]> => {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: {
                accountId: true,
                shares: {
                    select: {
                        sharedWithUserId: true
                    }
                }
            }
        });
        if (!session) {
            return [];
        }
        const ids = new Set<string>();
        ids.add(session.accountId);
        for (const share of session.shares) {
            ids.add(share.sharedWithUserId);
        }
        return Array.from(ids);
    };

    const emitUpdateToSessionParticipants = async (params: {
        sessionId: string;
        senderUserId: string;
        skipSenderConnection?: ClientConnection;
        buildPayload: (updateSeq: number, updateId: string) => any;
    }): Promise<void> => {
        const participantUserIds = await getSessionParticipantUserIds(params.sessionId);
        await Promise.all(participantUserIds.map(async (participantUserId) => {
            const updSeq = await allocateUserSeq(participantUserId);
            const payload = params.buildPayload(updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: participantUserId,
                payload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: params.sessionId },
                skipSenderConnection: participantUserId === params.senderUserId ? params.skipSenderConnection : undefined
            });
        }));
    };

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
            const access = await checkSessionAccess(userId, sid);
            if (!access || !requireAccessLevel(access, 'edit')) {
                if (callback) {
                    callback({ result: 'forbidden' });
                }
                return;
            }
            const session = await db.session.findUnique({
                where: { id: sid }
            });
            if (!session) {
                if (callback) {
                    callback({ result: 'error' });
                }
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

            // Generate session metadata update
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            await emitUpdateToSessionParticipants({
                sessionId: sid,
                senderUserId: userId,
                skipSenderConnection: connection,
                buildPayload: (updSeq, updId) => buildUpdateSessionUpdate(sid, updSeq, updId, metadataUpdate)
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
            const access = await checkSessionAccess(userId, sid);
            if (!access || !requireAccessLevel(access, 'edit')) {
                callback({ result: 'forbidden' });
                return;
            }
            const session = await db.session.findUnique({
                where: { id: sid }
            });
            if (!session) {
                callback({ result: 'error' });
                return;
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

            // Generate session agent state update
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            await emitUpdateToSessionParticipants({
                sessionId: sid,
                senderUserId: userId,
                skipSenderConnection: connection,
                buildPayload: (updSeq, updId) => buildUpdateSessionUpdate(sid, updSeq, updId, undefined, agentStateUpdate)
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
            activityCache.queueSessionUpdate(sid, userId, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const { sid, message, localId } = data;

                log({ module: 'websocket' }, `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${message.length} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`);

                // Resolve session
                const access = await checkSessionAccess(userId, sid);
                if (!access || !requireAccessLevel(access, 'edit')) {
                    return;
                }
                const session = await db.session.findUnique({
                    where: { id: sid }
                });
                if (!session) {
                    return;
                }
                let useLocalId = typeof localId === 'string' ? localId : null;

                // Create encrypted message
                const msgContent: PrismaJson.SessionMessageContent = {
                    t: 'encrypted',
                    c: message
                };

                // Resolve seq
                const msgSeq = await allocateSessionSeq(sid);

                // Check if message already exists
                if (useLocalId) {
                    const existing = await db.sessionMessage.findFirst({
                        where: { sessionId: sid, localId: useLocalId }
                    });
                    if (existing) {
                        return { msg: existing, update: null };
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

                // Emit new message update to relevant clients
                await emitUpdateToSessionParticipants({
                    sessionId: sid,
                    senderUserId: userId,
                    skipSenderConnection: connection,
                    buildPayload: (updSeq, updId) => buildNewMessageUpdate(msg, sid, updSeq, updId)
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
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

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
        }
    });

}

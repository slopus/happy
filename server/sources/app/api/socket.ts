import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateMachineUpdate, buildUpdateSessionUpdate, buildUsageEphemeral, ClientConnection, EventRouter } from "@/modules/eventRouter";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { allocateUserSeq } from "@/storage/seq";
import { allocateSessionSeq } from "@/storage/seq";
import { decrementWebSocketConnection, incrementWebSocketConnection, machineAliveEventsCounter, sessionAliveEventsCounter, websocketEventsCounter } from "../monitoring/metrics2";
import { AsyncLock } from "@/utils/lock";
import { activityCache } from "../presence/sessionCache";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

export function startSocket(app: Fastify, eventRouter: EventRouter) {
    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
            allowedHeaders: ["*"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false // Don't serve the client files
    });

    // Connection tracking is now handled by EventRouter

    // Track RPC listeners: Map<userId, Map<rpcMethodWithSessionPrefix, Socket>>
    // Only session-scoped clients (CLI) register handlers, only user-scoped clients (mobile) call them
    const rpcListeners = new Map<string, Map<string, Socket>>();

    io.on("connection", async (socket) => {
        log({ module: 'websocket' }, `New connection attempt from socket: ${socket.id}`);
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            socket.emit('error', { message: 'Missing authentication token' });
            socket.disconnect();
            return;
        }

        // Validate session-scoped clients have sessionId
        if (clientType === 'session-scoped' && !sessionId) {
            log({ module: 'websocket' }, `Session-scoped client missing sessionId`);
            socket.emit('error', { message: 'Session ID required for session-scoped clients' });
            socket.disconnect();
            return;
        }

        // Validate machine-scoped clients have machineId
        if (clientType === 'machine-scoped' && !machineId) {
            log({ module: 'websocket' }, `Machine-scoped client missing machineId`);
            socket.emit('error', { message: 'Machine ID required for machine-scoped clients' });
            socket.disconnect();
            return;
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            log({ module: 'websocket' }, `Invalid token provided`);
            socket.emit('error', { message: 'Invalid authentication token' });
            socket.disconnect();
            return;
        }

        const userId = verified.userId;
        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId
            };
        }
        eventRouter.addConnection(userId, connection);
        incrementWebSocketConnection(connection.connectionType);

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Lock
        const receiveMessageLock = new AsyncLock();
        const receiveUsageLock = new AsyncLock();

        socket.on('disconnect', () => {
            websocketEventsCounter.inc({ event_type: 'disconnect' });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            decrementWebSocketConnection(connection.connectionType);

            // Clean up RPC listeners for this socket
            const userRpcMap = rpcListeners.get(userId);
            if (userRpcMap) {
                // Remove all RPC methods registered by this socket
                const methodsToRemove: string[] = [];
                for (const [method, registeredSocket] of userRpcMap.entries()) {
                    if (registeredSocket === socket) {
                        methodsToRemove.push(method);
                    }
                }

                if (methodsToRemove.length > 0) {
                    log({ module: 'websocket-rpc' }, `Cleaning up RPC methods on disconnect for socket ${socket.id}: ${methodsToRemove.join(', ')}`);
                    methodsToRemove.forEach(method => userRpcMap.delete(method));
                }

                if (userRpcMap.size === 0) {
                    rpcListeners.delete(userId);
                    log({ module: 'websocket-rpc' }, `All RPC listeners removed for user ${userId}`);
                }
            }

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
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

                // Emit session activity update
                const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
                eventRouter.emitEphemeral({
                    userId,
                    payload: sessionActivity,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
            }
        });

        socket.on('machine-alive', async (data: {
            machineId: string;
            time: number;
        }) => {
            try {
                // Track metrics
                websocketEventsCounter.inc({ event_type: 'machine-alive' });
                machineAliveEventsCounter.inc();

                // Basic validation
                if (!data || typeof data.time !== 'number' || !data.machineId) {
                    return;
                }

                let t = data.time;
                if (t > Date.now()) {
                    t = Date.now();
                }
                if (t < Date.now() - 1000 * 60 * 10) {
                    return;
                }

                // Check machine validity using cache
                const isValid = await activityCache.isMachineValid(data.machineId, userId);
                if (!isValid) {
                    return;
                }

                // Queue database update (will only update if time difference is significant)
                activityCache.queueMachineUpdate(data.machineId, t);

                const machineActivity = buildMachineActivityEphemeral(data.machineId, true, t);
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in machine-alive: ${error}`);
            }
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
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
            }
        });

        socket.on('message', async (data: any) => {
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
                        return;
                    }
                    let useLocalId = typeof localId === 'string' ? localId : null;

                    // Create encrypted message
                    const msgContent: PrismaJson.SessionMessageContent = {
                        t: 'encrypted',
                        c: message
                    };

                    // Resolve seq
                    const updSeq = await allocateUserSeq(userId);
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
                    const updatePayload = buildNewMessageUpdate(msg, sid, updSeq, randomKeyNaked(12));
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        skipSenderConnection: connection
                    });
                } catch (error) {
                    log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
                }
            });
        });

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

                // Generate session metadata update
                const updSeq = await allocateUserSeq(userId);
                const metadataUpdate = {
                    value: metadata,
                    version: expectedVersion + 1
                };
                const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
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

                // Generate session agent state update
                const updSeq = await allocateUserSeq(userId);
                const agentStateUpdate = {
                    value: agentState,
                    version: expectedVersion + 1
                };
                const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
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

        // Machine metadata update with optimistic concurrency control
        socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
            try {
                const { machineId, metadata, expectedVersion } = data;

                // Validate input
                if (!machineId || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                    if (callback) {
                        callback({ result: 'error', message: 'Invalid parameters' });
                    }
                    return;
                }

                // Resolve machine
                const machine = await db.machine.findFirst({
                    where: {
                        accountId: userId,
                        id: machineId
                    }
                });
                if (!machine) {
                    if (callback) {
                        callback({ result: 'error', message: 'Machine not found' });
                    }
                    return;
                }

                // Check version
                if (machine.metadataVersion !== expectedVersion) {
                    callback({
                        result: 'version-mismatch',
                        version: machine.metadataVersion,
                        metadata: machine.metadata
                    });
                    return;
                }

                // Update metadata with atomic version check
                const { count } = await db.machine.updateMany({
                    where: {
                        accountId: userId,
                        id: machineId,
                        metadataVersion: expectedVersion  // Atomic CAS
                    },
                    data: {
                        metadata: metadata,
                        metadataVersion: expectedVersion + 1
                        // NOT updating active or lastActiveAt here
                    }
                });

                if (count === 0) {
                    // Re-fetch current version
                    const current = await db.machine.findFirst({
                        where: {
                            accountId: userId,
                            id: machineId
                        }
                    });
                    callback({
                        result: 'version-mismatch',
                        version: current?.metadataVersion || 0,
                        metadata: current?.metadata
                    });
                    return;
                }

                // Generate machine metadata update
                const updSeq = await allocateUserSeq(userId);
                const metadataUpdate = {
                    value: metadata,
                    version: expectedVersion + 1
                };
                const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), metadataUpdate);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });

                // Send success response with new version
                callback({
                    result: 'success',
                    version: expectedVersion + 1,
                    metadata: metadata
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in machine-update-metadata: ${error}`);
                if (callback) {
                    callback({ result: 'error', message: 'Internal error' });
                }
            }
        });

        // Machine daemon state update with optimistic concurrency control
        socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
            try {
                const { machineId, daemonState, expectedVersion } = data;

                // Validate input
                if (!machineId || typeof daemonState !== 'string' || typeof expectedVersion !== 'number') {
                    if (callback) {
                        callback({ result: 'error', message: 'Invalid parameters' });
                    }
                    return;
                }

                // Resolve machine
                const machine = await db.machine.findFirst({
                    where: {
                        accountId: userId,
                        id: machineId
                    }
                });
                if (!machine) {
                    if (callback) {
                        callback({ result: 'error', message: 'Machine not found' });
                    }
                    return;
                }

                // Check version
                if (machine.daemonStateVersion !== expectedVersion) {
                    callback({
                        result: 'version-mismatch',
                        version: machine.daemonStateVersion,
                        daemonState: machine.daemonState
                    });
                    return;
                }

                // Update daemon state with atomic version check
                const { count } = await db.machine.updateMany({
                    where: {
                        accountId: userId,
                        id: machineId,
                        daemonStateVersion: expectedVersion  // Atomic CAS
                    },
                    data: {
                        daemonState: daemonState,
                        daemonStateVersion: expectedVersion + 1,
                        active: true,
                        lastActiveAt: new Date()
                    }
                });

                if (count === 0) {
                    // Re-fetch current version
                    const current = await db.machine.findFirst({
                        where: {
                            accountId: userId,
                            id: machineId
                        }
                    });
                    callback({
                        result: 'version-mismatch',
                        version: current?.daemonStateVersion || 0,
                        daemonState: current?.daemonState
                    });
                    return;
                }

                // Generate machine daemon state update
                const updSeq = await allocateUserSeq(userId);
                const daemonStateUpdate = {
                    value: daemonState,
                    version: expectedVersion + 1
                };
                const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), undefined, daemonStateUpdate);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });

                // Send success response with new version
                callback({
                    result: 'success',
                    version: expectedVersion + 1,
                    daemonState: daemonState
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in machine-update-state: ${error}`);
                if (callback) {
                    callback({ result: 'error', message: 'Internal error' });
                }
            }
        });

        // RPC register - Register this socket as a listener for an RPC method
        socket.on('rpc-register', async (data: any) => {
            try {
                const { method } = data;

                if (!method || typeof method !== 'string') {
                    socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                    return;
                }

                // Get or create user's RPC map
                let userRpcMap = rpcListeners.get(userId);
                if (!userRpcMap) {
                    userRpcMap = new Map<string, Socket>();
                    rpcListeners.set(userId, userRpcMap);
                }

                // Check if method was already registered
                const previousSocket = userRpcMap.get(method);
                if (previousSocket && previousSocket !== socket) {
                    log({ module: 'websocket-rpc' }, `RPC method ${method} re-registered: ${previousSocket.id} -> ${socket.id}`);
                }

                // Register this socket as the listener for this method
                userRpcMap.set(method, socket);

                socket.emit('rpc-registered', { method });
                log({ module: 'websocket-rpc' }, `RPC method registered: ${method} on socket ${socket.id} (user: ${userId})`);
                log({ module: 'websocket-rpc' }, `Active RPC methods for user ${userId}: ${Array.from(userRpcMap.keys()).join(', ')}`);
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
                socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
            }
        });

        // RPC unregister - Remove this socket as a listener for an RPC method
        socket.on('rpc-unregister', async (data: any) => {
            try {
                const { method } = data;

                if (!method || typeof method !== 'string') {
                    socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                    return;
                }

                const userRpcMap = rpcListeners.get(userId);
                if (userRpcMap && userRpcMap.get(method) === socket) {
                    userRpcMap.delete(method);
                    log({ module: 'websocket-rpc' }, `RPC method unregistered: ${method} from socket ${socket.id} (user: ${userId})`);

                    if (userRpcMap.size === 0) {
                        rpcListeners.delete(userId);
                        log({ module: 'websocket-rpc' }, `All RPC methods unregistered for user ${userId}`);
                    } else {
                        log({ module: 'websocket-rpc' }, `Remaining RPC methods for user ${userId}: ${Array.from(userRpcMap.keys()).join(', ')}`);
                    }
                } else {
                    log({ module: 'websocket-rpc' }, `RPC unregister ignored: ${method} not registered on socket ${socket.id}`);
                }

                socket.emit('rpc-unregistered', { method });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
                socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
            }
        });

        // RPC call - Call an RPC method on another socket of the same user
        socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
            try {
                const { method, params } = data;

                if (!method || typeof method !== 'string') {
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'Invalid parameters: method is required'
                        });
                    }
                    return;
                }

                // Find the RPC listener for this method within the same user
                const userRpcMap = rpcListeners.get(userId);
                if (!userRpcMap) {
                    log({ module: 'websocket-rpc' }, `RPC call failed: No RPC methods registered for user ${userId}`);
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'No RPC methods registered'
                        });
                    }
                    return;
                }

                const targetSocket = userRpcMap.get(method);
                if (!targetSocket || !targetSocket.connected) {
                    log({ module: 'websocket-rpc' }, `RPC call failed: Method ${method} not available (disconnected or not registered)`);
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'RPC method not available'
                        });
                    }
                    return;
                }

                // Don't allow calling your own socket
                if (targetSocket === socket) {
                    log({ module: 'websocket-rpc' }, `RPC call failed: Attempted self-call on method ${method}`);
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'Cannot call RPC on the same socket'
                        });
                    }
                    return;
                }

                // Log RPC call initiation
                const startTime = Date.now();
                log({ module: 'websocket-rpc' }, `RPC call initiated: ${socket.id} -> ${method} (target: ${targetSocket.id})`);

                // Forward the RPC request to the target socket using emitWithAck
                try {
                    const response = await targetSocket.timeout(30000).emitWithAck('rpc-request', {
                        method,
                        params
                    });

                    const duration = Date.now() - startTime;
                    log({ module: 'websocket-rpc' }, `RPC call succeeded: ${method} (${duration}ms)`);

                    // Forward the response back to the caller via callback
                    if (callback) {
                        callback({
                            ok: true,
                            result: response
                        });
                    }

                } catch (error) {
                    const duration = Date.now() - startTime;
                    const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                    log({ module: 'websocket-rpc' }, `RPC call failed: ${method} - ${errorMsg} (${duration}ms)`);

                    // Timeout or error occurred
                    if (callback) {
                        callback({
                            ok: false,
                            error: errorMsg
                        });
                    }
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in rpc-call: ${error}`);
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Internal error'
                    });
                }
            }
        });

        socket.on('ping', async (callback: (response: any) => void) => {
            try {
                callback({});
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in ping: ${error}`);
            }
        });

        // Usage reporting
        socket.on('usage-report', async (data: any, callback?: (response: any) => void) => {
            await receiveUsageLock.inLock(async () => {
                try {
                    const { key, sessionId, tokens, cost } = data;

                    // Validate required fields
                    if (!key || typeof key !== 'string') {
                        if (callback) {
                            callback({ success: false, error: 'Invalid key' });
                        }
                        return;
                    }

                    // Validate tokens and cost objects
                    if (!tokens || typeof tokens !== 'object' || typeof tokens.total !== 'number') {
                        if (callback) {
                            callback({ success: false, error: 'Invalid tokens object - must include total' });
                        }
                        return;
                    }

                    if (!cost || typeof cost !== 'object' || typeof cost.total !== 'number') {
                        if (callback) {
                            callback({ success: false, error: 'Invalid cost object - must include total' });
                        }
                        return;
                    }

                    // Validate sessionId if provided
                    if (sessionId && typeof sessionId !== 'string') {
                        if (callback) {
                            callback({ success: false, error: 'Invalid sessionId' });
                        }
                        return;
                    }

                    try {
                        // If sessionId provided, verify it belongs to the user
                        if (sessionId) {
                            const session = await db.session.findFirst({
                                where: {
                                    id: sessionId,
                                    accountId: userId
                                }
                            });

                            if (!session) {
                                if (callback) {
                                    callback({ success: false, error: 'Session not found' });
                                }
                                return;
                            }
                        }

                        // Prepare usage data
                        const usageData: PrismaJson.UsageReportData = {
                            tokens,
                            cost
                        };

                        // Upsert the usage report
                        const report = await db.usageReport.upsert({
                            where: {
                                accountId_sessionId_key: {
                                    accountId: userId,
                                    sessionId: sessionId || null,
                                    key
                                }
                            },
                            update: {
                                data: usageData,
                                updatedAt: new Date()
                            },
                            create: {
                                accountId: userId,
                                sessionId: sessionId || null,
                                key,
                                data: usageData
                            }
                        });

                        log({ module: 'websocket' }, `Usage report saved: key=${key}, sessionId=${sessionId || 'none'}, userId=${userId}`);

                        // Emit usage ephemeral update if sessionId is provided
                        if (sessionId) {
                            const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
                            eventRouter.emitEphemeral({
                                userId,
                                payload: usageEvent,
                                recipientFilter: { type: 'user-scoped-only' }
                            });
                        }

                        if (callback) {
                            callback({
                                success: true,
                                reportId: report.id,
                                createdAt: report.createdAt.getTime(),
                                updatedAt: report.updatedAt.getTime()
                            });
                        }
                    } catch (error) {
                        log({ module: 'websocket', level: 'error' }, `Failed to save usage report: ${error}`);
                        if (callback) {
                            callback({ success: false, error: 'Failed to save usage report' });
                        }
                    }
                } catch (error) {
                    log({ module: 'websocket', level: 'error' }, `Error in usage-report handler: ${error}`);
                    if (callback) {
                        callback({ success: false, error: 'Internal error' });
                    }
                }
            });
        });

        socket.emit('auth', { success: true, user: userId });
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
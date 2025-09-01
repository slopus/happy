import fastify, { FastifyInstance } from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import { db } from "@/storage/db";
import { onShutdown } from "@/utils/shutdown";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { AsyncLock } from "@/utils/lock";
import { auth } from "@/app/auth/auth";
import {
    EventRouter,
    ClientConnection,
    buildNewMessageUpdate,
    buildUpdateSessionUpdate,
    buildUpdateMachineUpdate,
    buildSessionActivityEphemeral,
    buildMachineActivityEphemeral,
    buildUsageEphemeral,
} from "@/modules/eventRouter";
import {
    incrementWebSocketConnection,
    decrementWebSocketConnection,
    sessionAliveEventsCounter,
    machineAliveEventsCounter,
    websocketEventsCounter,
    httpRequestsCounter,
    httpRequestDurationHistogram
} from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { Fastify } from "./types";
import { registerAuthRoutes } from "./routes/authRoutes";
import { registerPushRoutes } from "./routes/pushRoutes";
import { registerSessionRoutes } from "./routes/sessionRoutes";
import { registerConnectRoutes } from "./routes/connectRoutes";
import { registerAccountRoutes } from "./routes/accountRoutes";

export async function startApi(eventRouter: EventRouter): Promise<{ app: FastifyInstance; io: Server }> {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST', 'DELETE']
    });
    app.get('/', function (request, reply) {
        reply.send('Welcome to Happy Server!');
    });

    // Health check endpoint
    app.get('/health', async (request, reply) => {
        try {
            // Test database connectivity
            await db.$queryRaw`SELECT 1`;
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'happy-server'
            });
        } catch (error) {
            log({ module: 'health', level: 'error' }, `Health check failed: ${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'happy-server',
                error: 'Database connectivity failed'
            });
        }
    });

    // Add content type parser for webhook endpoints to preserve raw body
    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        function (req, body, done) {
            try {
                const bodyStr = body as string;

                // Handle empty body case - common for DELETE, GET requests
                if (!bodyStr || bodyStr.trim() === '') {
                    (req as any).rawBody = bodyStr;
                    // For DELETE and GET methods, empty body is expected
                    if (req.method === 'DELETE' || req.method === 'GET') {
                        done(null, undefined);
                        return;
                    }
                    // For other methods, return empty object
                    done(null, {});
                    return;
                }

                const json = JSON.parse(bodyStr);
                // Store raw body for webhook signature verification
                (req as any).rawBody = bodyStr;
                done(null, json);
            } catch (err: any) {
                log({ module: 'content-parser', level: 'error' }, `JSON parse error on ${req.method} ${req.url}: ${err.message}, body: "${body}"`);
                err.statusCode = 400;
                done(err, undefined);
            }
        }
    );

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);
    });

    // Global error handler
    app.setErrorHandler(async (error, request, reply) => {
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            userAgent,
            ip,
            statusCode: error.statusCode || 500,
            errorCode: error.code,
            stack: error.stack
        }, `Unhandled error: ${error.message}`);

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s
    app.setNotFoundHandler((request, reply) => {
        log({ module: '404-handler' }, `404 - Method: ${request.method}, Path: ${request.url}, Headers: ${JSON.stringify(request.headers)}`);
        reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${error.message}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: request.url,
                    stack: error.stack
                }, `Response serialization error: ${error.message}`);
                throw error;
            }
        };
    });

    // Authentication decorator
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            log({ module: 'auth-decorator' }, `Auth check - path: ${request.url}, has header: ${!!authHeader}, header start: ${authHeader?.substring(0, 50)}...`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            log({ module: 'auth-decorator' }, `Auth success - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Routes
    registerAuthRoutes(typed);
    registerPushRoutes(typed);
    registerSessionRoutes(typed, eventRouter);
    registerAccountRoutes(typed, eventRouter);
    registerConnectRoutes(typed, eventRouter);

    // Machines

    // POST /v1/machines - Create machine or return existing
    typed.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional() // Encrypted daemon state
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState } = request.body;

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            // Machine exists - just return it
            logger.info({ module: 'machines', machineId: id, userId }, 'Found existing machine');
            return reply.send({
                machine: {
                    id: machine.id,
                    metadata: machine.metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState,
                    daemonStateVersion: machine.daemonStateVersion,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: machine.createdAt.getTime(),
                    updatedAt: machine.updatedAt.getTime()
                }
            });
        } else {
            // Create new machine
            logger.info({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            const newMachine = await db.machine.create({
                data: {
                    id,
                    accountId: userId,
                    metadata,
                    metadataVersion: 1,
                    daemonState: daemonState || null,
                    daemonStateVersion: daemonState ? 1 : 0,
                    // Default to offline - in case the user does not start daemon
                    active: false,
                    // lastActiveAt and activeAt defaults to now() in schema
                }
            });

            // Emit update for new machine
            const updSeq = await allocateUserSeq(userId);
            const machineMetadata = {
                version: 1,
                value: metadata
            };
            const updatePayload = buildUpdateMachineUpdate(newMachine.id, updSeq, randomKeyNaked(12), machineMetadata);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload
            });

            return reply.send({
                machine: {
                    id: newMachine.id,
                    metadata: newMachine.metadata,
                    metadataVersion: newMachine.metadataVersion,
                    daemonState: newMachine.daemonState,
                    daemonStateVersion: newMachine.daemonStateVersion,
                    active: newMachine.active,
                    activeAt: newMachine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: newMachine.createdAt.getTime(),
                    updatedAt: newMachine.updatedAt.getTime()
                }
            });
        }
    });


    // Machines API
    typed.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' }
        });

        return machines.map(m => ({
            id: m.id,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/:id - Get single machine by ID
    typed.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

    // Combined logging endpoint (only when explicitly enabled)
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
        typed.post('/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
            schema: {
                body: z.object({
                    timestamp: z.string(),
                    level: z.string(),
                    message: z.string(),
                    messageRawObject: z.any().optional(),
                    source: z.enum(['mobile', 'cli']),
                    platform: z.string().optional()
                })
            }
        }, async (request, reply) => {
            const { timestamp, level, message, source, platform } = request.body;

            // Log ONLY to separate remote logger (file only, no console)
            const logData = {
                source,
                platform,
                timestamp
            };

            // Use the file-only logger if available
            const { fileConsolidatedLogger } = await import('@/utils/log');

            if (!fileConsolidatedLogger) {
                // Should never happen since we check env var above, but be safe
                return reply.send({ success: true });
            }

            switch (level.toLowerCase()) {
                case 'error':
                    fileConsolidatedLogger.error(logData, message);
                    break;
                case 'warn':
                case 'warning':
                    fileConsolidatedLogger.warn(logData, message);
                    break;
                case 'debug':
                    fileConsolidatedLogger.debug(logData, message);
                    break;
                default:
                    fileConsolidatedLogger.info(logData, message);
            }

            return reply.send({ success: true });
        });
    }

    // Start
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: '0.0.0.0' });

    // Socket IO - Create after server is listening
    if (!app.server) {
        throw new Error('Fastify server not available');
    }

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

    // End
    log('API ready on port http://localhost:' + port);

    onShutdown('api', async () => {
        await app.close();
    });
    onShutdown('api', async () => {
        await io.close();
    });

    return { app: app as unknown as FastifyInstance, io };
}
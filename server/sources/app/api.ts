import fastify, { FastifyInstance } from "fastify";
import { log } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import * as tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { Account, Update } from "@prisma/client";

// Connection metadata types
interface SessionScopedConnection {
    connectionType: 'session-scoped';
    socket: Socket;
    userId: string;
    sessionId: string;
}

interface UserScopedConnection {
    connectionType: 'user-scoped';
    socket: Socket;
    userId: string;
}

type ClientConnection = SessionScopedConnection | UserScopedConnection;

declare module 'fastify' {
    interface FastifyRequest {
        user: Account;
    }
    interface FastifyInstance {
        authenticate: any;
    }
}


export async function startApi(): Promise<{ app: FastifyInstance; io: Server }> {

    // Configure
    log('Starting API...');
    const tokenGenerator = await privacyKit.createPersistentTokenGenerator({
        service: 'handy',
        seed: process.env.HANDY_MASTER_SECRET!
    });
    const tokenVerifier = await privacyKit.createPersistentTokenVerifier({
        service: 'handy',
        publicKey: tokenGenerator.publicKey
    });

    // Start API
    const app = fastify({
        logger: true,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    app.register(require('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST']
    });
    app.get('/', function (request, reply) {
        reply.send('Welcome to Everything API!');
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Authentication decorator
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await tokenVerifier.verify(token);
            if (!verified) {
                return reply.code(401).send({ error: 'Invalid token' });
            }

            // Get user from database
            const user = await db.account.findUnique({
                where: { id: verified.user as string }
            });

            if (!user) {
                return reply.code(401).send({ error: 'User not found' });
            }

            request.user = user;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });

    // Send session update to all relevant connections
    let emitUpdateToInterestedClients = ({ event, userId, sessionId, payload, skipSenderConnection }: {
        event: string,
        userId: string,
        sessionId: string,
        payload: any,
        skipSenderConnection?: ClientConnection
    }) => {
        const connections = userIdToClientConnections.get(userId);
        if (!connections) {
            log({ module: 'websocket', level: 'warn' }, `No connections found for user ${userId}`);
            return;
        }

        for (const connection of connections) {
            // Skip message echo
            if (skipSenderConnection && connection === skipSenderConnection) {
                continue;
            }

            // Send to all user-scoped connections - we already matched user
            if (connection.connectionType === 'user-scoped') {
                log({ module: 'websocket' }, `Sending ${event} to user-scoped connection ${connection.socket.id}`);
                connection.socket.emit(event, payload);
            }

            // Send to all session-scoped connections, only that match sessionId
            if (connection.connectionType === 'session-scoped') {
                const matches = connection.sessionId === sessionId;
                log({ module: 'websocket' }, `Session-scoped connection ${connection.socket.id}: sessionId=${connection.sessionId}, messageSessionId=${sessionId}, matches=${matches}`);
                if (matches) {
                    log({ module: 'websocket' }, `Sending ${event} to session-scoped connection ${connection.socket.id}`);
                    connection.socket.emit(event, payload);
                }
            }
        }
    }

    // Auth schema
    typed.post('/v1/auth', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                challenge: z.string(),
                signature: z.string()
            })
        }
    }, async (request, reply) => {
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const challenge = privacyKit.decodeBase64(request.body.challenge);
        const signature = privacyKit.decodeBase64(request.body.signature);
        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const user = await db.account.upsert({
            where: { publicKey: publicKeyHex },
            update: { updatedAt: new Date() },
            create: { publicKey: publicKeyHex }
        });

        return reply.send({
            success: true,
            token: await tokenGenerator.new({ user: user.id })
        });
    });

    typed.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await db.terminalAuthRequest.upsert({
            where: { publicKey: privacyKit.encodeHex(publicKey) },
            update: {},
            create: { publicKey: privacyKit.encodeHex(publicKey) }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await tokenGenerator.new({ user: answer.responseAccountId!, extras: { session: answer.id } });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Approve auth request
    typed.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKey) }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (!authRequest.response) {
            await db.terminalAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.user.id }
            });
        }
        return reply.send({ success: true });
    });

    // Sessions API
    typed.get('/v1/sessions', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                active: true,
                lastActiveAt: true,
                messages: {
                    orderBy: { seq: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        seq: true,
                        content: true,
                        localId: true,
                        createdAt: true
                    }
                }
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                lastMessage: v.messages[0] ? {
                    id: v.messages[0].id,
                    seq: v.messages[0].seq,
                    localId: v.messages[0].localId,
                    content: v.messages[0].content,
                    createdAt: v.messages[0].createdAt.getTime()
                } : null
            }))
        });
    });

    // Create or load session by tag
    typed.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;
        const { tag, metadata } = request.body;

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime()
                }
            });
        } else {
            // Create new session with update
            const result = await db.$transaction(async (tx) => {
                // Get user for update sequence
                const user = await tx.account.findUnique({
                    where: { id: userId }
                });

                if (!user) {
                    throw new Error('User not found');
                }

                const updSeq = user.seq + 1;

                // Create session
                const session = await tx.session.create({
                    data: {
                        accountId: userId,
                        tag: tag,
                        metadata: metadata
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'new-session',
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime()
                };

                const update = await tx.update.create({
                    data: {
                        accountId: userId,
                        seq: updSeq,
                        content: updContent
                    }
                });

                // Update user sequence
                await tx.account.update({
                    where: { id: userId },
                    data: { seq: updSeq }
                });

                return { session, update };
            });

            // Emit update to connected sockets
            emitUpdateToInterestedClients({
                event: 'update',
                userId,
                sessionId: result.session.id,
                payload: {
                    id: result.update.id,
                    seq: result.update.seq,
                    body: result.update.content,
                    createdAt: result.update.createdAt.getTime()
                }
            });

            return reply.send({
                session: {
                    id: result.session.id,
                    seq: result.session.seq,
                    metadata: result.session.metadata,
                    metadataVersion: result.session.metadataVersion,
                    agentState: result.session.agentState,
                    agentStateVersion: result.session.agentStateVersion,
                    active: result.session.active,
                    activeAt: result.session.lastActiveAt.getTime(),
                    createdAt: result.session.createdAt.getTime(),
                    updatedAt: result.session.updatedAt.getTime()
                }
            });
        }
    });

    // Push Token Registration API
    typed.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;
        const { token } = request.body;

        try {
            await db.accountPushToken.upsert({
                where: {
                    accountId_token: {
                        accountId: userId,
                        token: token
                    }
                },
                update: {
                    updatedAt: new Date()
                },
                create: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    typed.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Get Push Tokens API
    typed.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });

    // Messages API
    typed.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

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

    // Track connections by scope type
    const userIdToClientConnections = new Map<string, Set<ClientConnection>>();

    // Track RPC listeners: Map<userId, Map<rpcMethodWithSessionPrefix, Socket>>
    // Only session-scoped clients (CLI) register handlers, only user-scoped clients (mobile) call them
    const rpcListeners = new Map<string, Map<string, Socket>>();

    io.on("connection", async (socket) => {
        log({ module: 'websocket' }, `New connection attempt from socket: ${socket.id}`);
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;

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

        const verified = await tokenVerifier.verify(token);
        if (!verified) {
            log({ module: 'websocket' }, `Invalid token provided`);
            socket.emit('error', { message: 'Invalid authentication token' });
            socket.disconnect();
            return;
        }

        const userId = verified.user as string;
        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, sessionId: ${sessionId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId };
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId
            };
        }
        if (!userIdToClientConnections.has(userId)) {
            userIdToClientConnections.set(userId, new Set());
        }
        userIdToClientConnections.get(userId)!.add(connection);

        socket.on('disconnect', () => {
            // Cleanup
            const connections = userIdToClientConnections.get(userId);
            if (connections) {
                connections.delete(connection);
                if (connections.size === 0) {
                    userIdToClientConnections.delete(userId);
                }
            }

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
        });

        socket.on('session-alive', async (data: any) => {
            const { sid, time, thinking } = data;
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
                data: { lastActiveAt: new Date(t), active: true }
            });

            // Emit update to connected sockets
            emitUpdateToInterestedClients({
                event: 'ephemeral',
                userId,
                sessionId: sid,
                payload: {
                    type: 'activity',
                    id: sid,
                    active: true,
                    activeAt: t,
                    thinking
                }
            });
        });

        socket.on('session-end', async (data: any) => {
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

            // Emit update to connected sockets
            emitUpdateToInterestedClients({
                event: 'ephemeral',
                userId,
                sessionId: sid,
                payload: {
                    type: 'activity',
                    id: sid,
                    active: false,
                    activeAt: t,
                    thinking: false
                }
            });
        });

        socket.on('message', async (data: any) => {
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

            // Start transaction to ensure consistency
            const result = await db.$transaction(async (tx) => {

                // Verify session belongs to user and lock it
                const session = await tx.session.findFirst({
                    where: {
                        id: sid,
                        accountId: userId
                    }
                });

                if (!session) {
                    throw new Error('Session not found');
                }

                // Get user for update
                const user = await tx.account.findUnique({
                    where: { id: userId }
                });

                if (!user) {
                    throw new Error('User not found');
                }

                // Get next sequence numbers
                const msgSeq = session.seq + 1;
                const updSeq = user.seq + 1;

                if (useLocalId) {
                    const existing = await tx.sessionMessage.findFirst({
                        where: { sessionId: sid, localId: useLocalId }
                    });
                    if (existing) {
                        return { msg: existing, update: null };
                    }
                }

                // Create message
                const msg = await tx.sessionMessage.create({
                    data: {
                        sessionId: sid,
                        seq: msgSeq,
                        content: msgContent,
                        localId: useLocalId
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'new-message',
                    sid: sid,
                    message: {
                        id: msg.id,
                        seq: msg.seq,
                        content: msgContent,
                        localId: useLocalId,
                        createdAt: msg.createdAt.getTime(),
                        updatedAt: msg.updatedAt.getTime()
                    }
                };

                const update = await tx.update.create({
                    data: {
                        accountId: userId,
                        seq: updSeq,
                        content: updContent
                    }
                });

                // Update sequences
                await tx.session.update({
                    where: { id: sid },
                    data: { seq: msgSeq }
                });

                await tx.account.update({
                    where: { id: userId },
                    data: { seq: updSeq }
                });

                return { msg, update };
            }).catch((error) => {
                if (error.message === 'Session not found') {
                    return null;
                }
                throw error;
            });

            // If no update, we're done
            if (!result) {
                return;
            }

            // Emit update to relevant clients
            if (result.update) {
                emitUpdateToInterestedClients({
                    event: 'update',
                    userId,
                    sessionId: sid,
                    payload: {
                        id: result.update.id,
                        seq: result.update.seq,
                        body: result.update.content,
                        createdAt: result.update.createdAt.getTime()
                    },
                    skipSenderConnection: connection
                });
            }
        });

        socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
            const { sid, metadata, expectedVersion } = data;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Start transaction to ensure consistency
            const result = await db.$transaction(async (tx) => {
                // Verify session belongs to user and lock it
                const session = await tx.session.findFirst({
                    where: {
                        id: sid,
                        accountId: userId
                    }
                });
                const user = await tx.account.findUnique({
                    where: { id: userId }
                });
                if (!user || !session) {
                    callback({ result: 'error' });
                    return null;
                }

                // Check version
                if (session.metadataVersion !== expectedVersion) {
                    callback({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                    return null;
                }

                // Get next sequence number
                const updSeq = user.seq + 1;
                const newMetadataVersion = session.metadataVersion + 1;

                // Update session metadata
                await tx.session.update({
                    where: { id: sid },
                    data: {
                        metadata: metadata,
                        metadataVersion: newMetadataVersion
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'update-session',
                    id: sid,
                    metadata: {
                        value: metadata,
                        version: newMetadataVersion
                    }
                };

                const update = await tx.update.create({
                    data: {
                        accountId: userId,
                        seq: updSeq,
                        content: updContent
                    }
                });

                // Update user sequence
                await tx.account.update({
                    where: { id: userId },
                    data: { seq: updSeq }
                });

                return { update, newMetadataVersion };
            });
            if (!result) {
                return;
            }

            // Emit update to connected sockets
            emitUpdateToInterestedClients({
                event: 'update',
                userId,
                sessionId: sid,
                payload: result.update
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: result.newMetadataVersion, metadata: metadata });

        });

        socket.on('update-state', async (data: any, callback: (response: any) => void) => {
            const { sid, agentState, expectedVersion } = data;

            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            // Start transaction to ensure consistency
            const result = await db.$transaction(async (tx) => {
                // Verify session belongs to user and lock it
                const session = await tx.session.findFirst({
                    where: {
                        id: sid,
                        accountId: userId
                    }
                });
                const user = await tx.account.findUnique({
                    where: { id: userId }
                });
                if (!user || !session) {
                    callback({ result: 'error' });
                    return null;
                }

                // Check version
                if (session.agentStateVersion !== expectedVersion) {
                    callback({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                    return null;
                }

                // Get next sequence number
                const updSeq = user.seq + 1;
                const newAgentStateVersion = session.agentStateVersion + 1;

                // Update session agent state
                await tx.session.update({
                    where: { id: sid },
                    data: {
                        agentState: agentState,
                        agentStateVersion: newAgentStateVersion
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'update-session',
                    id: sid,
                    agentState: {
                        value: agentState,
                        version: newAgentStateVersion
                    }
                };

                const update = await tx.update.create({
                    data: {
                        accountId: userId,
                        seq: updSeq,
                        content: updContent
                    }
                });

                // Update user sequence
                await tx.account.update({
                    where: { id: userId },
                    data: { seq: updSeq }
                });

                return { update, newAgentStateVersion };
            });
            if (!result) {
                return;
            }

            // Emit update to connected sockets
            emitUpdateToInterestedClients({
                event: 'update',
                userId,
                sessionId: sid,
                payload: {
                    id: result.update.id,
                    seq: result.update.seq,
                    body: result.update.content,
                    createdAt: result.update.createdAt.getTime()
                }
            });

            // Send success response with new version via callback
            callback({ result: 'success', version: result.newAgentStateVersion, agentState: agentState });
        });

        // RPC register - Register this socket as a listener for an RPC method
        socket.on('rpc-register', async (data: any) => {
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
        });

        // RPC unregister - Remove this socket as a listener for an RPC method
        socket.on('rpc-unregister', async (data: any) => {
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
        });

        // RPC call - Call an RPC method on another socket of the same user
        socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
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
        });

        socket.on('ping', async (callback: (response: any) => void) => {
            callback({});
        });

        socket.emit('auth', { success: true, user: userId });
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    // End
    log('API ready on port http://localhost:' + port);
    
    return { app, io };
}
import fastify from "fastify";
import { log } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import * as privacyKit from "privacy-kit";
import * as tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { Account, Update } from "@prisma/client";
import { pubsub } from "@/services/pubsub";

declare module 'fastify' {
    interface FastifyRequest {
        user: Account;
    }
    interface FastifyInstance {
        authenticate: any;
    }
}

export async function startApi() {

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

    // Auth schema
    const authSchema = z.object({
        publicKey: z.string(),
        challenge: z.string(),
        signature: z.string()
    });

    // Single auth endpoint
    typed.post('/v1/auth', {
        schema: {
            body: authSchema
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
                messages: {
                    orderBy: { seq: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        seq: true,
                        content: true,
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
                lastMessage: v.messages[0] ? {
                    id: v.messages[0].id,
                    seq: v.messages[0].seq,
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
                tag: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.user.id;
        const { tag } = request.body;

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
                        tag: tag
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'new-session',
                    id: session.id,
                    seq: session.seq,
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
            pubsub.emit('update', userId, result.update);

            return reply.send({
                session: {
                    id: result.session.id,
                    seq: result.session.seq,
                    createdAt: result.session.createdAt.getTime(),
                    updatedAt: result.session.updatedAt.getTime()
                }
            });
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

    // Track connected users
    const userSockets = new Map<string, Set<Socket>>();

    io.on("connection", async (socket) => {
        log({ module: 'websocket' }, `New connection attempt from socket: ${socket.id}`);
        const token = socket.handshake.auth.token as string;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            socket.emit('error', { message: 'Missing authentication token' });
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

        log({ module: 'websocket' }, `Token verified: ${verified.user}`);

        const userId = verified.user as string;

        // Track socket for user
        if (!userSockets.has(userId)) {
            userSockets.set(userId, new Set());
        }
        userSockets.get(userId)!.add(socket);

        // Subscribe to updates for this user
        const updateHandler = (accountId: string, update: Update) => {
            if (accountId === userId) {
                socket.emit('update', {
                    id: update.id,
                    seq: update.seq,
                    body: update.content,
                    createdAt: update.createdAt.getTime()
                });
            }
        };
        pubsub.on('update', updateHandler);

        socket.on('disconnect', () => {
            // Clean up
            const sockets = userSockets.get(userId);
            if (sockets) {
                sockets.delete(socket);
                if (sockets.size === 0) {
                    userSockets.delete(userId);
                }
            }
            pubsub.off('update', updateHandler);
            log({ module: 'websocket' }, `User disconnected: ${userId}`);
        });

        socket.on('message', async (data: any) => {
            const { sid, message } = data;

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

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

                // Create message
                const msg = await tx.sessionMessage.create({
                    data: {
                        sessionId: sid,
                        seq: msgSeq,
                        content: msgContent
                    }
                });

                // Create update
                const updContent: PrismaJson.UpdateBody = {
                    t: 'new-message',
                    sid: sid,
                    mid: msg.id,
                    c: msgContent
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

            if (!result) return;

            // Emit update to connected sockets
            pubsub.emit('update', userId, result.update);
        });

        socket.emit('auth', { success: true, user: userId });
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    // End
    log('API ready on port http://localhost:' + port);
}
import { z } from "zod";
import { type Fastify } from "../types";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Prisma } from "@prisma/client";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { GitHubProfile } from "../types";
import { separateName } from "@/utils/separateName";
import { uploadImage } from "@/storage/uploadImage";
import { EventRouter } from "@/app/events/eventRouter";
import { decryptString, encryptString } from "@/modules/encrypt";

export function connectRoutes(app: Fastify, eventRouter: EventRouter) {

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

    // GitHub OAuth parameters
    app.get('/v1/connect/github/params', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    url: z.string()
                }),
                400: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const clientId = process.env.GITHUB_CLIENT_ID;
        const redirectUri = process.env.GITHUB_REDIRECT_URL;

        if (!clientId || !redirectUri) {
            return reply.code(400).send({ error: 'GitHub OAuth not configured' });
        }

        // Generate ephemeral state token (5 minutes TTL)
        const state = await auth.createGithubToken(request.userId);

        // Build complete OAuth URL
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: 'read:user,user:email,read:org,codespace',
            state: state
        });

        const url = `https://github.com/login/oauth/authorize?${params.toString()}`;

        return reply.send({ url });
    });

    // GitHub OAuth callback (GET for redirect from GitHub)
    app.get('/v1/connect/github/callback', {
        schema: {
            querystring: z.object({
                code: z.string(),
                state: z.string()
            })
        }
    }, async (request, reply) => {
        const { code, state } = request.query;

        // Verify the state token to get userId
        const tokenData = await auth.verifyGithubToken(state);
        if (!tokenData) {
            log({ module: 'github-oauth' }, `Invalid state token: ${state}`);
            return reply.redirect('https://app.happy.engineering?error=invalid_state');
        }

        const userId = tokenData.userId;
        const clientId = process.env.GITHUB_CLIENT_ID;
        const clientSecret = process.env.GITHUB_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return reply.redirect('https://app.happy.engineering?error=server_config');
        }

        try {
            // Exchange code for access token
            const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    client_id: clientId,
                    client_secret: clientSecret,
                    code: code
                })
            });

            const tokenResponseData = await tokenResponse.json() as {
                access_token?: string;
                error?: string;
                error_description?: string;
            };

            if (tokenResponseData.error) {
                return reply.redirect(`https://app.happy.engineering?error=${encodeURIComponent(tokenResponseData.error)}`);
            }

            const accessToken = tokenResponseData.access_token;

            // Get user info from GitHub
            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                }
            });

            const userData = await userResponse.json() as GitHubProfile;

            if (!userResponse.ok) {
                return reply.redirect('https://app.happy.engineering?error=github_user_fetch_failed');
            }

            // Store GitHub user and connect to account
            const githubUser = await db.githubUser.upsert({
                where: { id: userData.id.toString() },
                update: {
                    profile: userData,
                    token: encryptString(['user', userId, 'github', 'token'], accessToken!)
                },
                create: {
                    id: userData.id.toString(),
                    profile: userData,
                    token: encryptString(['user', userId, 'github', 'token'], accessToken!)
                }
            });

            // Avatar
            log({ module: 'github-oauth' }, `Uploading avatar for user ${userId}: ${userData.avatar_url}`);
            const image = await fetch(userData.avatar_url);
            const imageBuffer = await image.arrayBuffer();
            log({ module: 'github-oauth' }, `Uploading avatar for user ${userId}: ${userData.avatar_url}`);
            const avatar = await uploadImage(userId, 'avatars', 'github', userData.avatar_url, Buffer.from(imageBuffer));
            log({ module: 'github-oauth' }, `Uploaded avatar for user ${userId}: ${userData.avatar_url}`);

            // Name
            const name = separateName(userData.name);
            log({ module: 'github-oauth' }, `Separated name for user ${userId}: ${userData.name} -> ${name.firstName} ${name.lastName}`);

            // Link GitHub user to account
            await db.account.update({
                where: { id: userId },
                data: { githubUserId: githubUser.id, avatar, firstName: name.firstName, lastName: name.lastName }
            });

            // Send account update to all user connections
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateAccountUpdate(userId, {
                github: userData,
                firstName: name.firstName,
                lastName: name.lastName,
                avatar: avatar
            }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-user-authenticated-connections' }
            });

            log({ module: 'github-oauth' }, `GitHub account connected successfully for user ${userId}: ${userData.login}`);

            // Redirect to app with success
            return reply.redirect(`https://app.happy.engineering?github=connected&user=${encodeURIComponent(userData.login)}`);

        } catch (error) {
            log({ module: 'github-oauth' }, `Error in GitHub GET callback: ${error}`);
            return reply.redirect('https://app.happy.engineering?error=server_error');
        }
    });

    // GitHub webhook handler with type safety
    app.post('/v1/connect/github/webhook', {
        schema: {
            headers: z.object({
                'x-hub-signature-256': z.string(),
                'x-github-event': z.string(),
                'x-github-delivery': z.string().optional()
            }).passthrough(),
            body: z.any(),
            response: {
                200: z.object({ received: z.boolean() }),
                401: z.object({ error: z.string() }),
                500: z.object({ error: z.string() })
            }
        }
    }, async (request, reply) => {
        const signature = request.headers['x-hub-signature-256'];
        const eventName = request.headers['x-github-event'];
        const deliveryId = request.headers['x-github-delivery'];
        const rawBody = (request as any).rawBody;

        if (!rawBody) {
            log({ module: 'github-webhook', level: 'error' },
                'Raw body not available for webhook signature verification');
            return reply.code(500).send({ error: 'Server configuration error' });
        }

        // Get the webhooks handler
        const { getWebhooks } = await import("@/modules/github");
        const webhooks = getWebhooks();
        if (!webhooks) {
            log({ module: 'github-webhook', level: 'error' },
                'GitHub webhooks not initialized');
            return reply.code(500).send({ error: 'Webhooks not configured' });
        }

        try {
            // Verify and handle the webhook with type safety
            await webhooks.verifyAndReceive({
                id: deliveryId || 'unknown',
                name: eventName,
                payload: typeof rawBody === 'string' ? rawBody : JSON.stringify(request.body),
                signature: signature
            });

            // Log successful processing
            log({
                module: 'github-webhook',
                event: eventName,
                delivery: deliveryId
            }, `Successfully processed ${eventName} webhook`);

            return reply.send({ received: true });

        } catch (error: any) {
            if (error.message?.includes('signature does not match')) {
                log({
                    module: 'github-webhook',
                    level: 'warn',
                    event: eventName,
                    delivery: deliveryId
                }, 'Invalid webhook signature');
                return reply.code(401).send({ error: 'Invalid signature' });
            }

            log({
                module: 'github-webhook',
                level: 'error',
                event: eventName,
                delivery: deliveryId
            }, `Error processing webhook: ${error.message}`);

            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    // GitHub disconnect endpoint
    app.delete('/v1/connect/github', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            // Get current user's GitHub connection
            const user = await db.account.findUnique({
                where: { id: userId },
                select: { githubUserId: true }
            });

            if (!user || !user.githubUserId) {
                return reply.code(404).send({ error: 'GitHub account not connected' });
            }

            const githubUserId = user.githubUserId;
            log({ module: 'github-disconnect' }, `Disconnecting GitHub account for user ${userId}: ${githubUserId}`);

            // Remove GitHub connection from account and delete GitHub user record
            await db.$transaction(async (tx) => {
                // Remove link from account and clear avatar
                await tx.account.update({
                    where: { id: userId },
                    data: {
                        githubUserId: null,
                        avatar: Prisma.JsonNull
                    }
                });

                // Delete GitHub user record (this also deletes the token)
                await tx.githubUser.delete({
                    where: { id: githubUserId }
                });
            });

            // Send account update to all user connections
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateAccountUpdate(userId, {
                github: null,
                avatar: null
            }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-user-authenticated-connections' }
            });

            log({ module: 'github-disconnect' }, `GitHub account and avatar disconnected successfully for user ${userId}`);

            return reply.send({ success: true });

        } catch (error) {
            log({ module: 'github-disconnect', level: 'error' }, `Error disconnecting GitHub account: ${error}`);
            return reply.code(500).send({ error: 'Failed to disconnect GitHub account' });
        }
    });

    //
    // Inference endpoints
    //

    app.post('/v1/connect/:vendor/register', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                token: z.string()
            }),
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const encrypted = encryptString(['user', userId, 'vendors', request.params.vendor, 'token'], request.body.token);
        await db.serviceAccountToken.upsert({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            update: { updatedAt: new Date(), token: encrypted },
            create: { accountId: userId, vendor: request.params.vendor, token: encrypted }
        });
        reply.send({ success: true });
    });

    app.get('/v1/connect/:vendor/token', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            }),
            response: {
                200: z.object({
                    token: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const token = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            select: { token: true }
        });
        if (!token) {
            return reply.send({ token: null });
        } else {
            return reply.send({ token: decryptString(['user', userId, 'vendors', request.params.vendor, 'token'], token.token) });
        }
    });

    app.delete('/v1/connect/:vendor', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        await db.serviceAccountToken.delete({ where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } } });
        reply.send({ success: true });
    });

    app.get('/v1/connect/tokens', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    tokens: z.array(z.object({
                        vendor: z.string(),
                        token: z.string()
                    }))
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const tokens = await db.serviceAccountToken.findMany({ where: { accountId: userId } });
        let decrypted = [];
        for (const token of tokens) {
            decrypted.push({ vendor: token.vendor, token: decryptString(['user', userId, 'vendors', token.vendor, 'token'], token.token) });
        }
        return reply.send({ tokens: decrypted });
    });

}
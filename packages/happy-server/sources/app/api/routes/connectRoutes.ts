import { z } from "zod";
import { type Fastify, GitHubProfile } from "../types";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { eventRouter } from "@/app/events/eventRouter";
import { decryptString, encryptString } from "@/modules/encrypt";
import { githubConnect } from "@/app/github/githubConnect";
import { githubDisconnect } from "@/app/github/githubDisconnect";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { INFERENCE_VENDORS } from "@/utils/inferenceVendors";
import { isLikelyGithubPat } from "@/utils/validateGithubPat";

export function connectRoutes(app: Fastify) {

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

            // Use the new githubConnect operation
            const ctx = Context.create(userId);
            await githubConnect(ctx, userData, accessToken!);

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

        // Verify and handle the webhook with type safety
        try {
            await webhooks.verifyAndReceive({
                id: deliveryId || 'unknown',
                name: eventName,
                payload: typeof rawBody === 'string' ? rawBody : JSON.stringify(request.body),
                signature: signature
            });
            return reply.send({ received: true });
        } catch (error: any) {
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
        const ctx = Context.create(userId);
        try {
            await githubDisconnect(ctx);
            return reply.send({ success: true });
        } catch (error: any) {
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
                vendor: z.enum(INFERENCE_VENDORS)
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
                vendor: z.enum(INFERENCE_VENDORS)
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
                vendor: z.enum(INFERENCE_VENDORS)
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
        // Inference-vendor allowlist — `/v1/connect/tokens` returns plaintext
        // tokens; non-inference vendors (e.g. github-pat) must NEVER leak
        // through this surface. See specs/remote-git-clone-per-user-credentials.
        const tokens = await db.serviceAccountToken.findMany({
            where: { accountId: userId, vendor: { in: [...INFERENCE_VENDORS] } }
        });
        let decrypted = [];
        for (const token of tokens) {
            decrypted.push({ vendor: token.vendor, token: decryptString(['user', userId, 'vendors', token.vendor, 'token'], token.token) });
        }
        return reply.send({ tokens: decrypted });
    });

    //
    // GitHub Personal Access Token (PAT) — separate surface from the
    // inference-vendor endpoints above. Rationale:
    //   - `/v1/connect/:vendor/token` returns plaintext for LLM SDKs, but
    //     GitHub PAT must never reach the browser (used only server-side to
    //     build `git clone` URLs in vite middleware / daemon RPC).
    //   - `status` exposes only registration metadata; `token` is the
    //     server-internal plaintext fetch (still bearer-authenticated as
    //     the requesting user, but expected to be called only by the
    //     vite middleware on behalf of that user).
    //
    // Cross-repo spec:
    //   aplus-dev-studio specs/remote-git-clone-per-user-credentials.
    //

    const GITHUB_PAT_VENDOR = 'github-pat';

    app.post('/v1/connect/github-pat/register', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                token: z.string().refine(isLikelyGithubPat, {
                    message: 'Token does not match a GitHub PAT shape (ghp_/github_pat_/gho_/ghs_ + ≥20 chars)'
                })
            }),
            response: {
                200: z.object({ success: z.literal(true) })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const encrypted = encryptString(['user', userId, 'vendors', GITHUB_PAT_VENDOR, 'token'], request.body.token);
        await db.serviceAccountToken.upsert({
            where: { accountId_vendor: { accountId: userId, vendor: GITHUB_PAT_VENDOR } },
            update: { updatedAt: new Date(), token: encrypted },
            create: { accountId: userId, vendor: GITHUB_PAT_VENDOR, token: encrypted }
        });
        return reply.send({ success: true });
    });

    app.get('/v1/connect/github-pat/status', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    hasPat: z.boolean(),
                    updatedAt: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor: GITHUB_PAT_VENDOR } },
            select: { updatedAt: true }
        });
        return reply.send({
            hasPat: !!row,
            updatedAt: row ? row.updatedAt.toISOString() : null
        });
    });

    app.delete('/v1/connect/github-pat', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ success: z.literal(true) })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        // Idempotent: deleting a non-existent row should not 500.
        await db.serviceAccountToken.deleteMany({
            where: { accountId: userId, vendor: GITHUB_PAT_VENDOR }
        });
        return reply.send({ success: true });
    });

    app.get('/v1/connect/github-pat/token', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({ token: z.string().nullable() })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const row = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor: GITHUB_PAT_VENDOR } },
            select: { token: true }
        });
        if (!row) {
            return reply.send({ token: null });
        }
        // Update lastUsedAt without blocking the response — best-effort.
        db.serviceAccountToken.update({
            where: { accountId_vendor: { accountId: userId, vendor: GITHUB_PAT_VENDOR } },
            data: { lastUsedAt: new Date() }
        }).catch((err) => {
            log({ module: 'github-pat', level: 'warn' }, `lastUsedAt update failed: ${err?.message ?? err}`);
        });
        const plaintext = decryptString(['user', userId, 'vendors', GITHUB_PAT_VENDOR, 'token'], row.token);
        return reply.send({ token: plaintext });
    });

}
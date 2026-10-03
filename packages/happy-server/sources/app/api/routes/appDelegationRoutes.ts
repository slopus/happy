import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { appConversations, appTurns, deleteAppConversation, approveAppPairing, cancelAppTurn, claimAppTurn, createAppPairing, delegatedApp, DelegationError, describeAppPairing, publishAppTurn, redeemAppPairing, readAppTurn, revokeAppGrant, withAppGrant, ownerAppConversations, deleteOwnedAppGrant } from '@/app/appDelegation/appDelegation';

import { openOwnedAppConversation, readAppHistory, readOwnedAppConversation } from '@/app/appDelegation/appHistory';

const id = z.string().uuid();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const envelope = z.string().min(80).max(16384);
const ciphertext = z.string().min(60).max(8 * 1024 * 1024);
const bearer = (header?: string): string => header?.startsWith('Bearer ') ? header.slice(7) : '';

export function appDelegationRoutes(app: Fastify) {
    const rateLimits = new Map<string, { count: number; until: number }>();
    app.register(async instance => {
        const routes = instance.withTypeProvider<ZodTypeProvider>();
        routes.addHook('onRoute', options => { options.bodyLimit ??= 4096; });
        routes.addHook('onRequest', async (request, reply) => {
            reply.header('Cache-Control', 'no-store');
            reply.header('Referrer-Policy', 'no-referrer');
            if (request.url.startsWith('/v1/apps/pairings')) {
                const now = Date.now();
                for (const [key, value] of rateLimits) if (value.until <= now) rateLimits.delete(key);
                const creating = request.url.split('?')[0] === '/v1/apps/pairings';
                const key = `${request.ip}:${creating ? 'create' : 'poll'}`;
                const bucket = rateLimits.get(key) ?? { count: 0, until: now + (creating ? 600_000 : 60_000) };
                if ((!rateLimits.has(key) && rateLimits.size >= 4096) || ++bucket.count > (creating ? 10 : 100)) return reply.code(429).send({ error: 'Too many authorization requests; try later' });
                rateLimits.set(key, bucket);
            }
            // CORS is a browser boundary, not the source of application authority.
            if (request.url.startsWith('/v1/apps/') && request.headers.origin && request.headers.origin !== delegatedApp.origin) {
                return reply.code(403).send({ error: 'Application origin is not registered' });
            }
        });
        routes.setErrorHandler((error, _request, reply) => {
            if (error instanceof DelegationError) return reply.code(error.statusCode).send({ error: error.message });
            if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) return reply.code(413).send({ error: 'Request too large' });
            if (error && typeof error === 'object' && 'validation' in error) return reply.code(400).send({ error: 'Invalid request' });
            return reply.code(500).send({ error: 'Application service unavailable' });
        });
        routes.post('/v1/apps/pairings', { bodyLimit: 2048, schema: { body: z.object({ appId: z.literal('relationship-advisor'), protocol: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), challengeHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() } }, async request => createAppPairing(request.body));
        routes.post('/v1/apps/pairings/:id/redeem', { bodyLimit: 2048, schema: { params: z.object({ id }), body: z.object({ verifier: secret, credential: secret }).strict() } }, async request => redeemAppPairing(request.params.id, request.body.verifier, request.body.credential));
        routes.get('/v1/app-authorizations/requests/:id', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => describeAppPairing(request.params.id));
        routes.post('/v1/app-authorizations/requests/:id/approve', { bodyLimit: 40 * 1024, preHandler: app.authenticate, schema: { params: z.object({ id }), body: z.object({ machineId: z.string().min(1).max(200), expiresAt: z.string().datetime().nullable(), appEnvelope: envelope, machineEnvelope: envelope, protocol: z.literal(3).optional() }).strict() } }, async request => approveAppPairing(request.userId, request.params.id, request.body));
        routes.get('/v1/app-authorizations', { preHandler: app.authenticate }, async request => ({ grants: await db.appDelegation.findMany({ where: { accountId: request.userId }, select: { id: true, appId: true, machineId: true, state: true, expiresAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } }) }));
        routes.get('/v1/app-authorizations/workers', { preHandler: app.authenticate }, async request => ({ workers: await db.appChatWorker.findMany({ where: { accountId: request.userId, activeUntil: { gt: new Date() }, protocol: { in: [1, 2, 3] } }, select: { machineId: true, protocol: true } }) }));
        routes.get('/v1/app-authorizations/conversations', { preHandler: app.authenticate, schema: { querystring: z.object({ cursor: id.optional() }) } }, async request => ownerAppConversations(request.userId, request.query.cursor));
        routes.post('/v1/app-authorizations/conversations/:id/open', { preHandler: app.authenticate, schema: { params: z.object({ id }), body: z.object({}).strict() } }, async request => openOwnedAppConversation(request.userId, request.params.id));
        routes.get('/v1/app-authorizations/conversations/:id/history', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => readOwnedAppConversation(request.userId, request.params.id));
        routes.get('/v1/apps/history/:id', { schema: { params: z.object({ id }) } }, async request => readAppHistory(bearer(request.headers.authorization), request.params.id));
        routes.delete('/v1/app-authorizations/:id/history', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => deleteOwnedAppGrant(request.userId, request.params.id));
        routes.delete('/v1/app-authorizations/:id', { preHandler: app.authenticate, schema: { params: z.object({ id }) } }, async request => revokeAppGrant(request.userId, request.params.id));
        routes.get('/v1/apps/connection', {}, async request => withAppGrant(bearer(request.headers.authorization), async (tx, grant) => ({ id: grant.id, machineId: grant.machineId, expiresAt: grant.expiresAt, scope: grant.protocol >= 3 ? 'agent:chat' : 'codex:chat', worker: await tx.appChatWorker.findFirst({ where: { machineId: grant.machineId!, activeUntil: { gt: new Date() } }, select: { protocol: true, engines: true } }), app: delegatedApp })));
        routes.delete('/v1/apps/connection', {}, async request => {
            const grant = await withAppGrant(bearer(request.headers.authorization), async (_tx, grant) => ({ id: grant.id, accountId: grant.accountId! }));
            return revokeAppGrant(grant.accountId, grant.id);
        });
        routes.get('/v1/apps/conversations', {}, async request => ({ conversations: await appConversations(bearer(request.headers.authorization)) }));
        routes.post('/v1/apps/conversations', { schema: { body: z.object({ id }).strict() } }, async request => ({ conversations: await appConversations(bearer(request.headers.authorization), request.body.id) }));
        routes.delete('/v1/apps/conversations/:id', { schema: { params: z.object({ id }) } }, async request => deleteAppConversation(bearer(request.headers.authorization), request.params.id));
        routes.get('/v1/apps/conversations/:id/turns', { schema: { params: z.object({ id }), querystring: z.object({ before: z.string().datetime().optional() }) } }, async request => ({ turns: await appTurns(bearer(request.headers.authorization), request.params.id, undefined, request.query.before) }));
        routes.post('/v1/apps/conversations/:id/turns', { bodyLimit: 9 * 1024 * 1024, schema: { params: z.object({ id }), body: z.object({ id, input: ciphertext, minimumProtocol: z.literal(3).optional() }).strict() } }, async request => ({ turns: await appTurns(bearer(request.headers.authorization), request.params.id, request.body) }));
        routes.get('/v1/apps/turns/:id', { schema: { params: z.object({ id }) } }, async request => readAppTurn(bearer(request.headers.authorization), request.params.id));
        routes.post('/v1/apps/turns/:id/cancel', { schema: { params: z.object({ id }) } }, async request => cancelAppTurn(bearer(request.headers.authorization), request.params.id));
        routes.post('/v1/app-worker/:machineId/claim', { preHandler: app.authenticate, schema: { params: z.object({ machineId: z.string().min(1).max(200) }), body: z.object({ protocol: z.union([z.literal(1), z.literal(2), z.literal(3)]), engines: z.array(z.enum(['codex', 'claude'])).max(2).optional() }).strict() } }, async request => claimAppTurn(request.userId, request.params.machineId, request.body.protocol, request.body.engines));
        routes.post('/v1/app-worker/:machineId/turns/:id', { preHandler: app.authenticate, bodyLimit: 2 * 1024 * 1024, schema: { params: z.object({ machineId: z.string().min(1).max(200), id }), body: z.object({ lease: secret, sequence: z.number().int().positive().optional(), output: z.string().min(60).max(1024 * 1024).optional(), state: z.enum(['completed', 'failed']).optional() }).strict() } }, async request => publishAppTurn(request.userId, request.params.machineId, request.params.id, request.body));
    });
}

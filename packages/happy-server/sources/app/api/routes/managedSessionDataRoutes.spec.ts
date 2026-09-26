import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import type { PrismaClient } from '@prisma/client';
import { eventRouter } from '@/app/events/eventRouter';
import * as logModule from '@/utils/log';
import type { SessionScopedClaims, SessionScopedTokenIssuer } from '@/app/auth/sessionScopedToken';

/**
 * Session data routes reached by a managed child, against a real Fastify
 * instance and the real database.
 *
 * Two things are asserted throughout: the child can act inside its own session,
 * and every refusal is provably inert — the full row snapshot of the fixtures'
 * own sessions and messages must be unchanged. A route that rejects after
 * writing is not a rejection.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL`, like the other real-database
 * suites.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
    HANDY_MASTER_SECRET: process.env.HANDY_MASTER_SECRET,
};
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const HOUR = 3_600_000;

let db: PrismaClient;
let modules: {
    auth: typeof import('@/app/auth/auth');
    tokens: typeof import('@/app/auth/sessionScopedToken');
    enable: typeof import('@/app/api/utils/enableAuthentication');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
    v3Sessions: typeof import('@/app/api/routes/v3SessionRoutes');
    v3Events: typeof import('@/app/api/routes/v3SessionEventRoutes');
    sessions: typeof import('@/app/api/routes/sessionRoutes');
};

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let issuer: SessionScopedTokenIssuer;

let accountId: string;
let otherAccountId: string;
let accountToken: string;
let otherAccountToken: string;
let sessionId: string;
let otherSessionId: string;
let workspaceId: string;
let runId: string;
let grantId: string;
let grantExpiresAt: number;
let scopedToken: string;

function scope(over: Record<string, unknown> = {}) {
    return {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        workspaceId,
        runtimeId: 'runtime-1',
        epoch: 1,
        runId,
        attemptId: 'attempt-1',
        sessionId,
        accountId,
        workspaceAuthorityVersion: 1,
        runAuthorityVersion: 1,
        ...over,
    };
}

function claimsFor(over: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    const s = scope();
    return {
        v: 1,
        grantId,
        accountId: s.accountId,
        sessionId: s.sessionId,
        tenantId: s.tenantId,
        projectId: s.projectId,
        workspaceId: s.workspaceId,
        runtimeId: s.runtimeId,
        runId: s.runId,
        attemptId: s.attemptId,
        epoch: s.epoch,
        workspaceAuthorityVersion: s.workspaceAuthorityVersion,
        runAuthorityVersion: s.runAuthorityVersion,
        // Exactly the grant's own expiry: a token may never claim to outlive
        // the row that authorises it.
        purpose: 'runner' as const,
        expiresAt: grantExpiresAt,
        ...over,
    };
}

async function mintScopedToken(over: Partial<SessionScopedClaims> = {}): Promise<string> {
    const minted = await issuer.mint(claimsFor(over), Date.now());
    if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
    return minted.token;
}

function request(input: {
    method: 'GET' | 'POST';
    url: string;
    token: string;
    body?: unknown;
    instance?: FastifyInstance;
}) {
    return (input.instance ?? app).inject({
        method: input.method,
        url: input.url,
        headers: {
            authorization: `Bearer ${input.token}`,
            'content-type': 'application/json',
        },
        ...(input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    });
}

/**
 * Full rows for the fixtures' own sessions and their messages and events.
 *
 * Counts would miss a handler that updates a row and then refuses, which is
 * the shape of bug worth catching here. Scoped to created ids so nothing
 * belonging to anyone else is read.
 */
async function dataSnapshot() {
    const ids = [...createdSessionIds];
    const [sessions, messages, events] = await Promise.all([
        db.session.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }),
        db.sessionMessage.findMany({ where: { sessionId: { in: ids } }, orderBy: { id: 'asc' } }),
        db.sessionEvent.findMany({ where: { sessionId: { in: ids } }, orderBy: { id: 'asc' } }),
    ]);
    return { sessions, messages, events };
}

async function expectInert<T extends { statusCode: number }>(
    run: () => Promise<T>,
    status: number,
): Promise<T> {
    const before = await dataSnapshot();
    const response = await run();
    expect(response.statusCode).toBe(status);
    expect(await dataSnapshot()).toEqual(before);
    return response;
}

async function buildApp(getIssuer: () => SessionScopedTokenIssuer | null): Promise<FastifyInstance> {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>();
    modules.enable.enableAuthentication(typed as never);
    modules.enable.enableSessionScopeAuthentication(typed as never, getIssuer);
    modules.v3Sessions.v3SessionRoutes(typed as never);
    modules.v3Events.v3SessionEventRoutes(typed as never);
    modules.sessions.sessionRoutes(typed as never);
    await instance.ready();
    return instance;
}

describe.skipIf(!enabled)('managed session data routes (real Fastify + PostgreSQL)', () => {
    beforeAll(async () => {
        modules = {
            auth: await import('@/app/auth/auth'),
            tokens: await import('@/app/auth/sessionScopedToken'),
            enable: await import('@/app/api/utils/enableAuthentication'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
            v3Sessions: await import('@/app/api/routes/v3SessionRoutes'),
            v3Events: await import('@/app/api/routes/v3SessionEventRoutes'),
            sessions: await import('@/app/api/routes/sessionRoutes'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();
        // The routes fan out through the event router, which is a process-wide
        // singleton normally initialised by `startSocket`. These cases are about
        // authorisation, not delivery, so it gets a sink rather than a server.
        eventRouter.init({ to: () => ({ emit: () => {} }) } as never);
        issuer = await modules.tokens.createSessionScopedTokenIssuer({
            seed: 'test-scoped-seed-not-a-production-key',
        });
        app = await buildApp(() => issuer);
        unconfiguredApp = await buildApp(() => null);
    });

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        otherAccountId = other.id;
        createdAccountIds.add(accountId);
        createdAccountIds.add(otherAccountId);
        accountToken = await modules.auth.auth.createToken(accountId);
        otherAccountToken = await modules.auth.auth.createToken(otherAccountId);

        // Two sessions on the *same* account: the child holds a grant for one
        // of them, so "another session" is not merely "another account".
        const granted = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        const sibling = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = granted.id;
        otherSessionId = sibling.id;
        createdSessionIds.add(sessionId);
        createdSessionIds.add(otherSessionId);

        await modules.projection.syncWorkspaceAuthority({
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
            expectedVersion: 0,
            now: Date.now(),
        });
        await modules.projection.syncRunAuthority({
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
            expectedVersion: 0,
            now: Date.now(),
        });
        const issued = await modules.grants.issueSessionGrant({
            scope: scope() as never,
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: Date.now() + HOUR,
            now: Date.now(),
        });
        if (!issued.ok) throw new Error(`fixture grant failed: ${issued.reason}`);
        grantId = issued.grant.grantId;
        grantExpiresAt = issued.grant.expiresAt;
        scopedToken = await mintScopedToken();
    });

    afterEach(async () => {
        const ids = [...createdSessionIds];
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.sessionMessage.deleteMany({ where: { sessionId: { in: ids } } });
        await db.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        expect(await dataSnapshot()).toEqual({ sessions: [], messages: [], events: [] });
        await app?.close();
        await unconfiguredApp?.close();
        await db.$disconnect();
        restoreEnv();
    });

    const messageBody = { messages: [{ localId: 'local-1', content: 'ciphertext' }] };

    describe('a child acts inside its own session', () => {
        it('reads and writes its own messages', async () => {
            const posted = await request({
                method: 'POST', url: `/v3/sessions/${sessionId}/messages`,
                token: scopedToken, body: messageBody,
            });
            expect(posted.statusCode).toBe(200);

            const read = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
            });
            expect(read.statusCode).toBe(200);
            expect(read.json().messages).toHaveLength(1);
        });

        it('reads its own events', async () => {
            const read = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/events`, token: scopedToken,
            });
            expect(read.statusCode).toBe(200);
        });

        it.each([undefined, 'seq', 'version'])('looks itself up, and only itself (projection %s)', async (projection) => {
            const found = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: scopedToken, body: { ids: [sessionId], ...(projection ? { projection } : {}) },
            });
            expect(found.statusCode).toBe(200);
            expect(found.json().sessions.map((s: { id: string }) => s.id)).toEqual([sessionId]);
            const stored = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
            if (projection === 'seq') {
                expect(found.json()).toEqual({ sessions: [{ id: sessionId, seq: stored.seq }] });
            }
            if (projection === 'version') {
                expect(found.json()).toEqual({ sessions: [{
                    id: sessionId,
                    seq: stored.seq,
                    createdAt: stored.createdAt.getTime(),
                    updatedAt: stored.updatedAt.getTime(),
                    active: stored.active,
                    activeAt: stored.lastActiveAt.getTime(),
                    metadataVersion: stored.metadataVersion,
                    agentStateVersion: stored.agentStateVersion,
                    hasDataEncryptionKey: stored.dataEncryptionKey !== null,
                }] });
            }
        });

        it('carries a query string without losing the route decision', async () => {
            const read = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages?after_seq=0&limit=10`,
                token: scopedToken,
            });
            expect(read.statusCode).toBe(200);
        });
    });

    describe('a read bearer reads, and only reads', () => {
        /*
         * The unit tests prove the allowlist branches. What only this level can
         * show is that the **real** consumer passes the purpose it verified: a
         * read token that reached this surface as a runner would be a browser
         * holding execution on somebody's session, and every branch test would
         * still be green.
         */
        /**
         * A **real** read grant, and a token minted from it.
         *
         * Minting a read token against the runner's row proves nothing: the row
         * is what carries the authority, and a token claiming a purpose its row
         * does not have is refused for that reason alone — which would make a
         * write-refusal test pass while the purpose gate was never consulted.
         */
        async function readBearer(aclRevision = 1): Promise<string> {
            // The read path, not the runner path with a different label: a read
            // grant has no run, and a row that has one is a runner row wearing
            // the wrong name.
            const issued = await modules.grants.issueReadGrant({
                scope: {
                    tenantId: 'tenant-1',
                    projectId: 'project-1',
                    sessionId,
                    sessionOwnerAccountId: accountId,
                    viewerAccountId: accountId,
                    aclRevision,
                },
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                now: Date.now(),
            });
            if (!issued.ok) throw new Error(`fixture read grant failed: ${issued.reason}`);
            /*
             * Minted in the shape a read bearer actually has: the session and
             * its project, the viewer, and **no run** — the row it names has
             * none either, and a token that claimed one would be describing a
             * generation that is not what authorises it.
             */
            const base = claimsFor({
                purpose: 'transcript-read',
                grantId: issued.grant.grantId,
                expiresAt: issued.grant.expiresAt,
            });
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...read } = base;
            const minted = await issuer.mint(
                { ...read, viewerAccountId: issued.grant.viewerAccountId ?? accountId } as never,
                Date.now(),
            );
            if (!minted.ok) throw new Error(`fixture mint failed: ${minted.reason}`);
            return minted.token;
        }

        it('reads only its granted seq projection with a transcript-read bearer', async () => {
            const readToken = await readBearer();
            const stored = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
            const found = await request({
                method: 'POST', url: '/v2/sessions/lookup', token: readToken,
                body: { ids: [sessionId], projection: 'seq' },
            });
            expect(found.statusCode).toBe(200);
            expect(found.json()).toEqual({ sessions: [{ id: sessionId, seq: stored.seq }] });
            for (const ids of [[otherSessionId], [sessionId, otherSessionId]]) {
                await expectInert(() => request({
                    method: 'POST', url: '/v2/sessions/lookup', token: readToken,
                    body: { ids, projection: 'seq' },
                }), 403);
            }
        });

        it('stops an older generation\'s bearer over real HTTP the moment the parent moves on', async () => {
            /*
             * The access-list generation, asserted where it actually decides
             * something: a real request over the real route with the real
             * bearer, not a unit call on the grant module.
             *
             * The bearer keeps working until its own expiry unless something
             * re-reads the generation on every action. What made this worth a
             * separate case is that the withdrawal may never arrive: a revoke
             * naming the old generation is refused as stale, and one naming the
             * new generation closes a different row. If this request still
             * answered 200, a removed reader would keep reading for as long as
             * the grant lived.
             */
            const oldToken = await readBearer(1);
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: oldToken,
            })).statusCode).toBe(200);

            // The parent re-issues under the next generation. Nothing is
            // revoked, and nothing needs to be.
            const newToken = await readBearer(2);

            const afterMove = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: oldToken,
            });
            expect(afterMove.statusCode).toBe(403);
            expect(afterMove.json().reason).toBe('revoked');
            // And the current generation's bearer is unaffected: this is about
            // the old one stopping, not about reading breaking.
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: newToken,
            })).statusCode).toBe(200);
        });

        it('refuses a read bearer posting into the session, and writes nothing', async () => {
            const readToken = await readBearer();
            const before = await db.sessionMessage.count({ where: { sessionId } });
            const posted = await request({
                method: 'POST', url: `/v3/sessions/${sessionId}/messages`,
                token: readToken, body: messageBody,
            });
            expect(posted.statusCode).toBe(403);
            // A refusal that still stored the message would be a refusal in
            // name only — the status code is not the property under test.
            expect(await db.sessionMessage.count({ where: { sessionId } })).toBe(before);
        });

        it('lets the same bearer read the transcript it was issued for', async () => {
            // The refusal above must be about the write, not about the token.
            const readToken = await readBearer();
            const read = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: readToken,
            });
            expect(read.statusCode).toBe(200);
        });

        it('refuses a read token whose grant belongs to another viewer', async () => {
            /*
             * One viewer's grant must never authorise another's token: the
             * resealed key envelope on that row is for one account, and lending
             * the row would lend the envelope with it.
             */
            const readToken = await readBearer();
            const issued = await modules.grants.issueReadGrant({
                scope: {
                    tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                    sessionOwnerAccountId: accountId, viewerAccountId: 'another-viewer',
                    aclRevision: 1,
                },
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                now: Date.now(),
                // A viewer who is not the owner cannot be issued without one.
                viewerDataEncryptionKey: Buffer.concat([
                    Buffer.from([0]), Buffer.alloc(104, 4),
                ]).toString('base64'),
            });
            expect(issued.ok).toBe(true);
            if (!issued.ok) return;
            // The other viewer's grant id, carried by this viewer's token.
            const base = claimsFor({
                purpose: 'transcript-read',
                grantId: issued.grant.grantId,
                expiresAt: issued.grant.expiresAt,
            });
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...read } = base;
            const minted = await issuer.mint(
                { ...read, viewerAccountId: accountId } as never, Date.now(),
            );
            expect(minted.ok).toBe(true);
            if (!minted.ok) return;
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: minted.token,
            })).statusCode).toBe(403);
            expect(readToken).not.toBe(minted.token);
        });

        it('refuses a read token that names a runner grant', async () => {
            /*
             * The row is what authorises, and a runner row authorises a run.
             * A read token pointed at one would inherit that authority while
             * being checked by none of the rules a runner token is checked by.
             */
            const base = claimsFor({ purpose: 'transcript-read' });
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...read } = base;
            const minted = await issuer.mint(
                { ...read, viewerAccountId: accountId } as never, Date.now(),
            );
            expect(minted.ok).toBe(true);
            if (!minted.ok) return;
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: minted.token,
            })).statusCode).toBe(403);
        });

        it('refuses a read token that names a runner grant and no viewer', async () => {
            /*
             * The variant the viewer comparison cannot catch: no viewer on
             * either side, so what is left is the row's own shape. A runner row
             * has a run and says `runner`, and a read token must be refused by
             * that alone.
             */
            const base = claimsFor({ purpose: 'transcript-read' });
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...read } = base;
            const minted = await issuer.mint({ ...read } as never, Date.now());
            expect(minted.ok).toBe(true);
            if (!minted.ok) return;
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: minted.token,
            })).statusCode).toBe(403);
        });

        it('hands a viewer its own key envelope, not the owner\'s', async () => {
            /*
             * The owner's envelope is sealed for the owner's account. Serving it
             * to a member of a company project gives them bytes they cannot
             * open, and the screen shows an empty conversation rather than a
             * permissions problem. The viewer's own resealed envelope is what
             * makes the transcript readable at all.
             */
            const envelope = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 9)]);
            const viewerAccountId = 'company-member-1';
            const issued = await modules.grants.issueReadGrant({
                scope: {
                    tenantId: 'tenant-1', projectId: 'project-1', sessionId,
                    sessionOwnerAccountId: accountId, viewerAccountId,
                    aclRevision: 1,
                },
                grantId: `grant-${randomUUID()}`,
                requestId: `req-${randomUUID()}`,
                expiresAt: Date.now() + HOUR,
                now: Date.now(),
                viewerDataEncryptionKey: envelope.toString('base64'),
            });
            expect(issued.ok).toBe(true);
            if (!issued.ok) return;
            const base = claimsFor({
                purpose: 'transcript-read',
                grantId: issued.grant.grantId,
                expiresAt: issued.grant.expiresAt,
            });
            const { workspaceId, runtimeId, runId, attemptId, epoch,
                workspaceAuthorityVersion, runAuthorityVersion, ...read } = base;
            const minted = await issuer.mint(
                { ...read, viewerAccountId } as never, Date.now(),
            );
            expect(minted.ok).toBe(true);
            if (!minted.ok) return;

            const response = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: minted.token, body: { ids: [sessionId] },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().sessions[0].dataEncryptionKey)
                .toBe(envelope.toString('base64'));

            // The version projection reports the envelope this viewer would
            // receive, so a client comparing it never mistakes the owner's.
            const versions = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: minted.token, body: { ids: [sessionId], projection: 'version' },
            });
            expect(versions.statusCode).toBe(200);
            expect(versions.json().sessions[0].hasDataEncryptionKey).toBe(true);
            expect(versions.json().sessions[0]).not.toHaveProperty('dataEncryptionKey');
        });

        it('leaves an owner reading their own transcript with the session\'s envelope', async () => {
            /*
             * The reader **is** the owner here, and the stored envelope is
             * already sealed for them. Handing back `null` because a read grant
             * carries no resealed copy would lock an owner out of their own
             * transcript — the resealing exists for somebody else.
             */
            const owned = Buffer.concat([Buffer.from([0]), Buffer.alloc(104, 3)]);
            await db.session.update({
                where: { id: sessionId },
                data: { dataEncryptionKey: owned },
            });
            const readToken = await readBearer();
            const response = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: readToken, body: { ids: [sessionId] },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().sessions[0].dataEncryptionKey).toBe(owned.toString('base64'));
        });

        it('still lets a runner post', async () => {
            const posted = await request({
                method: 'POST', url: `/v3/sessions/${sessionId}/messages`,
                token: scopedToken, body: messageBody,
            });
            expect(posted.statusCode).toBe(200);
        });
    });

    describe('another session is refused, even on the same account', () => {
        it('refuses reads and writes for a sibling session', async () => {
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${otherSessionId}/messages`, token: scopedToken,
            }), 403);
            await expectInert(() => request({
                method: 'POST', url: `/v3/sessions/${otherSessionId}/messages`,
                token: scopedToken, body: messageBody,
            }), 403);
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${otherSessionId}/events`, token: scopedToken,
            }), 403);
        });

        it.each([undefined, 'seq', 'version'])('refuses a lookup that reaches wider than the grant (projection %s)', async (projection) => {
            for (const ids of [[otherSessionId], [sessionId, otherSessionId]]) {
                const response = await expectInert(() => request({
                    method: 'POST', url: '/v2/sessions/lookup', token: scopedToken,
                    body: { ids, ...(projection ? { projection } : {}) },
                }), 403);
                // Not a filtered answer: nothing comes back at all.
                expect(response.body).not.toContain(otherSessionId);
            }
        });

        it('refuses a route no child may reach', async () => {
            // POST on the events path writes session events; no managed
            // consumer needs it, and sharing the path does not carry it in.
            // Bodies are valid for their routes, so the refusal is the auth
            // decision and not a schema rejection standing in for one.
            await expectInert(() => request({
                method: 'POST', url: `/v3/sessions/${sessionId}/events`,
                token: scopedToken, body: { eventType: 'agent-message', content: 'x' },
            }), 401);
            // Session creation would produce a session nothing has scoped.
            await expectInert(() => request({
                method: 'POST', url: '/v1/sessions',
                token: scopedToken, body: { tag: `tag-${randomUUID()}`, metadata: '{}' },
            }), 401);
            await expectInert(() => request({
                method: 'GET', url: '/v2/sessions', token: scopedToken,
            }), 401);
        });
    });

    describe('the grant is re-derived on every request', () => {
        async function expectRefusedNow(reason: string) {
            const response = await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
            }), 403);
            expect(response.json()).toMatchObject({ reason });
        }

        it('refuses immediately after the grant is revoked', async () => {
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
            })).statusCode).toBe(200);

            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            // No cache stands between the revoke and the next request.
            await expectRefusedNow('revoked');
        });

        it('refuses once the workspace advances its epoch', async () => {
            await modules.projection.syncWorkspaceAuthority({
                body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 2, runtimeId: 'runtime-2' },
                expectedVersion: 1,
                now: Date.now(),
            });
            await expectRefusedNow('authority-stale');
        });

        it('refuses once the run advances its attempt', async () => {
            await modules.projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                expectedVersion: 1,
                now: Date.now(),
            });
            await expectRefusedNow('attempt-mismatch');
        });

        it('refuses once the run is cancelled', async () => {
            await modules.projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: true },
                expectedVersion: 1,
                now: Date.now(),
            });
            await expectRefusedNow('run-cancelled');
        });

        it('refuses an expired token', async () => {
            const expired = await issuer.mint(claimsFor({ expiresAt: Date.now() + 60 }), Date.now());
            expect(expired.ok).toBe(true);
            if (!expired.ok) return;
            await new Promise((resolve) => setTimeout(resolve, 80));
            // Expiry is a token-level refusal, so it never reaches the scope
            // check — it is unauthenticated, not forbidden.
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: expired.token,
            }), 401);
        });

        it('refuses once the session changes owner', async () => {
            await db.session.update({
                where: { id: sessionId }, data: { accountId: otherAccountId },
            });
            const response = await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toMatchObject({ reason: 'session-owner-changed' });
            await db.session.update({ where: { id: sessionId }, data: { accountId } });
        });
    });

    describe('token shape and configuration', () => {
        it('refuses a scoped bearer when no issuer is configured', async () => {
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`,
                token: scopedToken, instance: unconfiguredApp,
            }), 401);
            // Not a blanket failure: the same instance still serves accounts,
            // so the refusal is about managed access being off.
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`,
                token: accountToken, instance: unconfiguredApp,
            })).statusCode).toBe(200);
        });

        it('refuses a token whose claims do not match the stored grant', async () => {
            const forged = await mintScopedToken({ epoch: 9 });
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: forged,
            }), 403);
        });

        it('refuses a token naming a grant that was never issued', async () => {
            const forged = await mintScopedToken({ grantId: 'never-issued' });
            const response = await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: forged,
            }), 403);
            expect(response.json()).toMatchObject({ reason: 'grant-unknown' });
        });

        it('refuses a missing or malformed bearer', async () => {
            await expectInert(() => app.inject({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`,
            }), 401);
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: 'not-a-token',
            }), 401);
        });
    });

    describe('nothing is established before the request is authorised', () => {
        /**
         * The decorator is called directly because the property under test is
         * invisible from a handler: a refused request never reaches one, so a
         * route-level assertion cannot tell whether `userId` was set on the way
         * to the refusal. Setting it early would hand a later hook, or any code
         * added after this one, an account identity the caller never proved.
         */
        async function runDecorator(token: string, url: string, body?: unknown) {
            const request: Record<string, unknown> = {
                headers: { authorization: `Bearer ${token}` },
                method: body === undefined ? 'GET' : 'POST',
                url,
                body,
            };
            let status: number | undefined;
            const reply = { code: (n: number) => { status = n; return { send: () => undefined }; } };
            await (app as unknown as { authenticateSessionScope: (r: unknown, p: unknown) => Promise<void> })
                .authenticateSessionScope(request, reply);
            return { request, status };
        }

        it('leaves userId and principal unset when the scope check refuses', async () => {
            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            const { request, status } = await runDecorator(scopedToken, `/v3/sessions/${sessionId}/messages`);
            expect(status).toBe(403);
            expect(request.userId).toBeUndefined();
            expect(request.principal).toBeUndefined();
        });

        it('leaves them unset when the route is not on the allowlist', async () => {
            const { request, status } = await runDecorator(scopedToken, `/v3/sessions/${otherSessionId}/messages`);
            expect(status).toBe(403);
            expect(request.userId).toBeUndefined();
            expect(request.principal).toBeUndefined();
        });

        it('marks an accepted managed request as a managed principal, never an account one', async () => {
            const { request, status } = await runDecorator(scopedToken, `/v3/sessions/${sessionId}/messages`);
            expect(status).toBeUndefined();
            expect(request.userId).toBe(accountId);
            // Same id as an account bearer would carry, which is exactly why
            // the kind has to be recorded separately.
            expect(request.principal).toMatchObject({
                kind: 'managed-session',
                claims: { accountId, sessionId, grantId },
            });
        });

        it('marks an account bearer as an account principal', async () => {
            const { request, status } = await runDecorator(accountToken, `/v3/sessions/${sessionId}/messages`);
            expect(status).toBeUndefined();
            expect(request.principal).toMatchObject({ kind: 'account', accountId });
        });
    });

    describe('an unreachable authority store is not a bad bearer', () => {
        /**
         * Swaps `db.$transaction`, which is where `resolveLiveGrant` reads. The
         * failure is a real driver-shaped rejection, so the decorator has to
         * classify it rather than let a generic catch call the token invalid.
         */
        function breakAuthorityStore(error: Error): () => void {
            type Fn = (...args: never[]) => never;
            const original = (db as unknown as { $transaction: Fn }).$transaction.bind(db);
            (db as unknown as { $transaction: Fn }).$transaction =
                (() => Promise.reject(error)) as Fn;
            return () => {
                (db as unknown as { $transaction: Fn }).$transaction = original;
            };
        }

        it('answers 503 rather than 401, and writes nothing', async () => {
            const restore = breakAuthorityStore(Object.assign(
                new Error('connect ECONNREFUSED 127.0.0.1:5432 postgresql://user:hunter2@db/app'),
                { name: 'PrismaClientInitializationError' },
            ));
            try {
                // 401 would tell a healthy caller its credential is invalid and
                // invite it to throw away a token that is fine.
                const response = await expectInert(() => request({
                    method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
                }), 503);
                expect(response.json()).toEqual({ error: 'Authorization unavailable' });
            } finally {
                restore();
            }
        });

        it('answers 503 on a write path too, without persisting the message', async () => {
            const restore = breakAuthorityStore(Object.assign(
                new Error('Timed out fetching a new connection from the pool'),
                { name: 'PrismaClientKnownRequestError' },
            ));
            try {
                await expectInert(() => request({
                    method: 'POST', url: `/v3/sessions/${sessionId}/messages`,
                    token: scopedToken, body: messageBody,
                }), 503);
            } finally {
                restore();
            }
        });

        /**
         * Everything the logger is handed, captured at the call. pino's
         * destination is bound when the module loads, so intercepting stdout
         * afterwards would observe nothing and pass vacuously.
         */
        async function captureLogsDuring(run: () => Promise<unknown>): Promise<string> {
            const logged: string[] = [];
            const record = (...args: unknown[]) => {
                logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
            };
            const spies = [
                vi.spyOn(logModule, 'log').mockImplementation(record as never),
                vi.spyOn(logModule, 'debug').mockImplementation(record as never),
            ];
            try {
                await run();
            } finally {
                for (const spy of spies) spy.mockRestore();
            }
            return logged.join('\n');
        }

        it('repeats no part of a driver error, whatever it calls itself', async () => {
            // `name` is an ordinary writable property: a driver, or a payload
            // that reached one, can put a credential there. Neither half of the
            // error may reach the log or the response.
            const leak = 'sk-live-LEAK';
            const restore = breakAuthorityStore(Object.assign(
                new Error(`connect failed for ${leak} at postgresql://user:hunter2@db/app`),
                { name: leak, code: leak },
            ));
            let body = '';
            let output = '';
            try {
                output = await captureLogsDuring(async () => {
                    const response = await request({
                        method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
                    });
                    expect(response.statusCode).toBe(503);
                    body = response.body;
                });
            } finally {
                restore();
            }
            for (const forbidden of [leak, 'hunter2', 'postgresql://', scopedToken, scopedToken.slice(0, 16)]) {
                expect(output, `log leaked ${forbidden}`).not.toContain(forbidden);
                expect(body, `response leaked ${forbidden}`).not.toContain(forbidden);
            }
            // An unrecognised failure is still reported, as a fixed label.
            expect(output).toContain('Authorization store unavailable (unclassified)');
        });

        it('names a failure only when it is on the closed list', async () => {
            const restore = breakAuthorityStore(Object.assign(
                new Error('connect ECONNREFUSED postgresql://user:hunter2@db/app'),
                { name: 'PrismaClientInitializationError' },
            ));
            let output = '';
            try {
                output = await captureLogsDuring(() => request({
                    method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: scopedToken,
                }));
            } finally {
                restore();
            }
            expect(output).toContain('Authorization store unavailable (PrismaClientInitializationError)');
            expect(output).not.toContain('hunter2');
            expect(output).not.toContain('ECONNREFUSED');
        });

        it('still refuses a bad bearer with 401 while the store is down', async () => {
            const restore = breakAuthorityStore(Object.assign(
                new Error('down'), { name: 'PrismaClientInitializationError' },
            ));
            try {
                // Token verification needs no database, so an unverifiable
                // bearer is still an unverifiable bearer.
                await expectInert(() => request({
                    method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: 'not-a-token',
                }), 401);
            } finally {
                restore();
            }
        });
    });

    describe('account bearers keep their behaviour', () => {
        it('reads and writes any of its own sessions', async () => {
            expect((await request({
                method: 'POST', url: `/v3/sessions/${otherSessionId}/messages`,
                token: accountToken, body: messageBody,
            })).statusCode).toBe(200);
            expect((await request({
                method: 'GET', url: `/v3/sessions/${otherSessionId}/messages`, token: accountToken,
            })).statusCode).toBe(200);
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/events`, token: accountToken,
            })).statusCode).toBe(200);
        });

        it.each([undefined, 'seq'])('looks up several of its own sessions at once (projection %s)', async (projection) => {
            const found = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: accountToken, body: { ids: [sessionId, otherSessionId], ...(projection ? { projection } : {}) },
            });
            expect(found.statusCode).toBe(200);
            expect(found.json().sessions).toHaveLength(2);
        });

        it.each([undefined, 'seq'])('still cannot reach another account*s session (projection %s)', async (projection) => {
            await expectInert(() => request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: otherAccountToken,
            }), 404);
            const found = await request({
                method: 'POST', url: '/v2/sessions/lookup',
                token: otherAccountToken, body: { ids: [sessionId], ...(projection ? { projection } : {}) },
            });
            expect(found.statusCode).toBe(200);
            expect(found.json().sessions).toEqual([]);
        });

        it('is not affected by a revoked managed grant', async () => {
            await modules.grants.revokeSessionGrant({
                scope: scope() as never, reason: 'operator', now: Date.now(),
            });
            expect((await request({
                method: 'GET', url: `/v3/sessions/${sessionId}/messages`, token: accountToken,
            })).statusCode).toBe(200);
        });
    });
});

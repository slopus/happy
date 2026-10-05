import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CapabilityCatalog, ServicePrincipal } from '@slopus/happy-wire';

const state = vi.hoisted(() => ({ database: null as unknown as PrismaClient }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: (_, key) => {
    const value = (state.database as any)[key];
    return typeof value === 'function' ? value.bind(state.database) : value;
} }) }));
import { createAIServiceStore } from './store';
import { createServiceTurns } from './turns';
import { createServiceGrants, serviceDigest } from './grants';
import { codexAccountStore, createServiceCodexGrant } from '@/app/api/routes/codexAccountStore';
import { initEncrypt } from '@/modules/encrypt';

const testUrl = process.env.PAWS_TEST_POSTGRES_URL;
function barrier() {
    let signal!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { signal = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let used = false;
    return { reached, release, async pause() { if (!used) { used = true; signal(); await resume; } } };
}
type Query = { model: string; method: string; args: any[] };
/** Test-only interception, after real preceding SQL has acquired its locks. */
function instrument(database: PrismaClient, name: string, before?: (query: Query) => Promise<void>) {
    return new Proxy(database, { get(target, key) {
        if (key === '$transaction') return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL application_name = '${name}'`);
            await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Shanghai'`;
            const proxy = new Proxy(tx, { get(client, model) {
                const value = (client as any)[model];
                if (typeof value === 'function') return async (...args: any[]) => {
                    await before?.({ model: '$', method: String(model), args });
                    return value.apply(client, args);
                };
                if (!value || typeof value !== 'object') return value;
                return new Proxy(value, { get(delegate, method) {
                    const query = delegate[method];
                    if (typeof query !== 'function') return query;
                    return async (...args: any[]) => {
                        await before?.({ model: String(model), method: String(method), args });
                        return query.apply(delegate, args);
                    };
                } });
            } });
            return operation(proxy);
        }, { timeout: 15000 });
        const value = (target as any)[key];
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

// An explicit, isolated local PostgreSQL URL is required. Default package tests keep PGlite coverage.
describe.skipIf(!testUrl)('real PostgreSQL claim and Account/identity lock ordering', () => {
    let adminUrl: string, databaseName: string, first: PrismaClient, second: PrismaClient, observer: PrismaClient;
    let sequence = 0;
    beforeAll(async () => {
        const url = new URL(testUrl!);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username !== 'paws_test' || url.pathname !== '/postgres') {
            throw new Error('Use the explicitly provisioned local synthetic paws_test PostgreSQL cluster');
        }
        adminUrl = url.toString();
        databaseName = `paws_ai_concurrency_${randomUUID().replace(/-/g, '')}`;
        execFileSync('psql', [adminUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${databaseName}"`], { stdio: 'pipe' });
        url.pathname = `/${databaseName}`;
        const migrations = resolve('prisma/migrations');
        const sql = readdirSync(migrations).filter(name => /^\d/.test(name)).sort().map(name => readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8')).join('\n');
        execFileSync('psql', [url.toString(), '-X', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
        first = new PrismaClient({ datasourceUrl: url.toString() });
        second = new PrismaClient({ datasourceUrl: url.toString() });
        observer = new PrismaClient({ datasourceUrl: url.toString() });
        expect((await observer.$queryRaw<{ server_version: string }[]>`SHOW server_version`)[0].server_version).toMatch(/^15\./);
        process.env.HANDY_MASTER_SECRET = 'synthetic-postgres-concurrency-master';
        await initEncrypt();
    }, 60000);
    afterAll(async () => {
        await Promise.all([first?.$disconnect(), second?.$disconnect(), observer?.$disconnect()]);
        if (databaseName) execFileSync('psql', [adminUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`], { stdio: 'pipe' });
    });
    async function fixture() {
        const ownerId = `pg-owner-${++sequence}`, machineId = `${ownerId}-machine`;
        await first.account.create({ data: { id: ownerId, publicKey: ownerId } });
        await first.machine.create({ data: { id: machineId, accountId: ownerId, metadata: 'sealed' } });
        state.database = second;
        const auth = { OPENAI_API_KEY: null, tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account_id: ownerId }, last_refresh: '2026-10-05T00:00:00.000Z' };
        const profile = (await codexAccountStore.upload(ownerId, auth)).profile;
        await codexAccountStore.bind(ownerId, machineId, { profileId: profile.id, expectedVersion: 0 });
        const nativeGrant = await codexAccountStore.createGrant(ownerId, machineId);
        const launch = await codexAccountStore.redeem(ownerId, machineId, nativeGrant.grant);
        const target = { machineId, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: profile.id } };
        const config = { ...target, modelId: null, reasoning: { mode: 'default' as const } };
        const source = { readLive: async (): Promise<CapabilityCatalog> => ({ ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'native', models: [{ id: 'native', name: 'Native', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } }] }) };
        const store = createAIServiceStore(first, source);
        const service = await store.createService(ownerId, { name: 'Existing', config });
        const scope = { appId: 'relationship-advisor', serviceId: service.id, targets: [target], permissions: ['chat' as const], expiresAt: null };
        const grant = await store.registerAuthorization(ownerId, { id: randomUUID(), kind: 'personal-grant', scope, allowModelOverride: false, allowReasoningOverride: false }, async (tx, grant) => {
            await tx.aIServiceAuthorization.update({ where: { id: grant.id }, data: { machineEnvelopes: { [machineId]: 'recipient-sealed' } } });
            await tx.appDelegation.create({ data: { id: grant.id, appId: scope.appId, accountId: ownerId, protocol: 4, state: 'service-ready', publicKey: '', challengeHash: '', requestExpiresAt: new Date() } });
        });
        const principal = { kind: 'personal-grant', ownerId, grantId: grant.id, scope } satisfies ServicePrincipal;
        await first.appChatWorker.create({ data: { machineId, accountId: ownerId, protocol: 3, serviceProtocol: 'ai-services/1', activeUntil: new Date(Date.now() + 60000) } });
        const binding = await store.resolveBinding(principal, scope.appId, service.id, {});
        return { ownerId, machineId, target, config, source, store, service, scope, principal, binding, profile, auth, launch };
    }
    async function waitUntilLock(name: string) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const rows = await observer.$queryRaw<{ query: string }[]>`SELECT query FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock'`;
            if (rows.length) return rows[0].query;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`No PostgreSQL lock wait for ${name}`);
    }

    it.each(['cancel', 'expiry', 'deadline', 'authorization-error'] as const)('does not undo %s after candidate selection', async mode => {
        const f = await fixture();
        const turn = await createServiceTurns(first, f.store).startBoundTurn(f.principal, f.binding.id, mode, { ciphertext: 'x'.repeat(80) });
        const paused = barrier();
        // Pause after authorization but before taking the turn lock (the old path updated directly).
        const claiming = instrument(first, `claim_${sequence}`, async ({ model, method, args }) => {
            if (mode === 'authorization-error' ? model === 'aIServiceBinding' && method === 'findFirst'
                : (model === 'appChatTurn' && ['update', 'updateMany'].includes(method) && args[0]?.data?.state === 'running') || (method === '$queryRaw' && String(args[0]).includes('SELECT "id" FROM "AppChatTurn"'))) await paused.pause();
        });
        const outcome = createServiceTurns(claiming, createAIServiceStore(claiming, f.source)).claim(f.ownerId, f.machineId).then(value => ({ value }), error => ({ error }));
        try {
            await paused.reached;
            const cancelling = createServiceTurns(second, createAIServiceStore(second, f.source));
            if (mode === 'cancel' || mode === 'authorization-error') await cancelling.cancelBoundTurn(f.principal, f.binding.id, turn.id);
            if (mode === 'expiry' || mode === 'deadline') {
                await second.appChatTurn.update({ where: { id: turn.id }, data: { deadline: new Date(0) } });
                if (mode === 'expiry') expect((await cancelling.readBoundTurn(f.principal, f.binding.id, turn.id)).record.status).toBe('interrupted');
            }
            if (mode === 'authorization-error') await second.aIService.update({ where: { id: f.service.id }, data: { enabled: false } });
        } finally { paused.release(); }
        expect(await outcome).toEqual({ value: null });
        const row = await first.appChatTurn.findUniqueOrThrow({ where: { id: turn.id } });
        expect(row.lease).toBeNull();
        expect(row.leaseUntil).toBeNull();
        expect(row.startedAt).toBeNull();
        expect(row.state).toBe(mode === 'cancel' || mode === 'authorization-error' ? 'cancelled' : mode === 'expiry' ? 'interrupted' : 'accepted');
    }, 20000);

    it('claims with UTC timestamp fields when the database session uses another timezone', async () => {
        const f = await fixture();
        const turn = await createServiceTurns(first, f.store).startBoundTurn(f.principal, f.binding.id, 'timezone', { ciphertext: 'x'.repeat(80) });
        const claiming = instrument(first, `claim_timezone_${sequence}`);
        const started = Date.now();
        const job = await createServiceTurns(claiming, createAIServiceStore(claiming, f.source)).claim(f.ownerId, f.machineId);
        expect(job?.record.id).toBe(turn.id);
        expect(job!.record.startedAt).toBeGreaterThanOrEqual(started);
        expect(job!.record.startedAt).toBeLessThanOrEqual(Date.now());
        const row = await first.appChatTurn.findUniqueOrThrow({ where: { id: turn.id } });
        expect(row.leaseUntil!.getTime() - Date.now()).toBeGreaterThan(10000);
        expect(row.leaseUntil!.getTime() - Date.now()).toBeLessThanOrEqual(15000);
    });

    it('keeps exact-proof personal redemption retries read-only while a turn start waits', async () => {
        const f = await fixture(), origin = 'https://advisor.paws.rodeo', verifier = 'synthetic-pairing-proof', secret = 's'.repeat(43);
        await first.appDelegation.update({ where: { id: f.principal.grantId }, data: { state: 'service-approved', challengeHash: serviceDigest(verifier), requestExpiresAt: new Date(Date.now() + 60000), appEnvelope: 'sealed-personal-envelope' } });
        const grants = createServiceGrants(first, f.store);
        const receipt = await grants.redeemPersonalPairing(f.principal.grantId, origin, verifier, secret);
        // The first redemption must commit before a real scoped token can authenticate.
        const principal = await grants.authenticate(`paws_service.${f.principal.grantId}.${secret}`, origin);
        const paused = barrier(), name = `start_during_redeem_${sequence}`;
        const retryWrites: string[] = [];
        const redeeming = instrument(first, `redeem_${sequence}`, async ({ model, method }) => {
            if (model === 'appDelegation' && method === 'findUnique') await paused.pause();
            if (['appDelegation', 'aIServiceAuthorization'].includes(model) && method.startsWith('update')) retryWrites.push(model);
        });
        const retry = createServiceGrants(redeeming, createAIServiceStore(redeeming, f.source)).redeemPersonalPairing(f.principal.grantId, origin, verifier, secret).then(value => ({ value }), error => ({ error }));
        let starting: Promise<unknown> | undefined, waitingQuery = '';
        try {
            await paused.reached;
            const client = instrument(second, name);
            starting = createServiceTurns(client, createAIServiceStore(client, f.source)).startBoundTurn(principal, f.binding.id, 'redeem-race', { ciphertext: 'x'.repeat(80) }).then(value => ({ value }), error => ({ error }));
            waitingQuery = await waitUntilLock(name);
        } finally { paused.release(); }
        const results = await Promise.all([retry, starting]);
        expect(results, `start waited on: ${waitingQuery}`).toEqual([{ value: receipt }, { value: expect.objectContaining({ status: 'accepted' }) }]);
        expect(waitingQuery).toContain('FROM "AppDelegation"');
        expect(retryWrites).toEqual([]);
    }, 20000);

    it.each(['native-grant', 'service', 'authorization', 'binding/cache', 'binding/insert'] as const)('orders Account before identity for %s versus real credential refresh', async mode => {
        const f = await fixture(), paused = barrier(), name = `refresh_${sequence}`;
        // A binding insert first writes its catalog row, which also has an Account FK.
        if (mode === 'binding/cache') await first.aIServiceCapabilitySnapshot.deleteMany({ where: { ownerId: f.ownerId } });
        const issuing = instrument(first, `issue_${sequence}`, async ({ model, method, args }) => {
            const match = mode === 'native-grant' ? model === 'codexSessionGrant' && method === 'create'
                : mode === 'service' ? model === 'aIService' && method === 'create'
                : mode === 'authorization' ? model === 'aIServiceAuthorization' && method === 'create'
                : mode === 'binding/insert' ? model === 'aIServiceBinding' && method === 'create'
                : model === '$' && method === '$executeRaw' && String(args[0]).includes('INSERT INTO "AIServiceCapabilitySnapshot"');
            if (match) await paused.pause();
        });
        const store = createAIServiceStore(issuing, f.source);
        const probeId = randomUUID(), lease = 'p'.repeat(43);
        await first.aIServiceProbe.create({ data: { id: probeId, ownerId: f.ownerId, machineId: f.machineId, principal: { kind: 'owner', ownerId: f.ownerId }, target: f.target, fingerprint: (await first.codexAccountProfile.findUniqueOrThrow({ where: { id: f.profile.id } })).externalAccountFingerprint, state: 'running', lease, deadline: new Date(Date.now() + 30000) } });
        const operation = mode === 'native-grant' ? issuing.$transaction(tx => createServiceCodexGrant(tx, f.ownerId, f.machineId, { kind: 'probe', id: probeId, lease }))
            : mode === 'service' ? store.createService(f.ownerId, { name: 'Concurrent', config: f.config })
            : mode === 'authorization' ? store.registerAuthorization(f.ownerId, { id: randomUUID(), kind: 'personal-grant', scope: f.scope, allowModelOverride: false, allowReasoningOverride: false })
            : store.resolveBinding(f.principal, f.scope.appId, f.service.id, {});
        const issued = operation.then(value => ({ value }), error => ({ error }));
        let refreshed: Promise<unknown> | undefined, waitingQuery = '';
        try {
            await paused.reached;
            state.database = instrument(second, name);
            refreshed = codexAccountStore.updateCredential(f.ownerId, f.profile.id, { machineId: f.machineId, launchId: f.launch.launchId, expectedVersion: 1, auth: { ...f.auth, tokens: { ...f.auth.tokens, access_token: 'rotated-synthetic' } } }).then(value => ({ value }), error => ({ error }));
            waitingQuery = await waitUntilLock(name);
        } finally { paused.release(); }
        const results = await Promise.all([issued, refreshed]);
        expect(results, `refresh waited on: ${waitingQuery}`).toEqual([expect.objectContaining({ value: expect.anything() }), expect.objectContaining({ value: expect.anything() })]);
        expect(waitingQuery).toContain('FROM "Account"');
        expect((await first.codexAccountProfile.findUniqueOrThrow({ where: { id: f.profile.id } })).credentialVersion).toBe(2);
    }, 20000);
    it('deduplicates simultaneous application conversation creation at the real PostgreSQL service-row lock', async () => {
        const f = await fixture(), paused = barrier();
        let observations = 0, releaseObservation!: () => void;
        const bothObserved = new Promise<void>(resolve => { releaseObservation = resolve; });
        const source = { readLive: async () => {
            if (++observations === 2) releaseObservation();
            await bothObserved;
            return f.source.readLive();
        } };
        const firstStore = createAIServiceStore(instrument(first, 'creation-first', async query => {
            if (query.model === 'aIServiceBinding' && query.method === 'create') await paused.pause();
        }), source);
        const secondStore = createAIServiceStore(instrument(second, 'creation-second'), source);
        const firstCreate = firstStore.resolveBinding(f.principal, f.scope.appId, f.service.id, {}, 'website-conversation');
        const secondCreate = secondStore.resolveBinding(f.principal, f.scope.appId, f.service.id, {}, 'website-conversation');
        await paused.reached;
        let waitingQuery = '';
        try { waitingQuery = await waitUntilLock('creation-second'); } finally { paused.release(); }
        const [a,b] = await Promise.all([firstCreate, secondCreate]);
        expect(waitingQuery).toContain('FROM "AIService"');
        expect(waitingQuery).toContain('FOR UPDATE');
        expect(a.id).toBe(b.id);
        expect(await observer.aIServiceBinding.count({ where: { authorizationId: f.principal.grantId, appConversationId: 'website-conversation' } })).toBe(1);
        const recovery = createAIServiceStore(second, { readLive: async () => { throw new Error('Recovery must not observe'); } });
        expect(await recovery.resolveBinding(f.principal, f.scope.appId, f.service.id, {}, 'website-conversation')).toEqual(a);
        await expect(recovery.resolveBinding(f.principal, f.scope.appId, f.service.id, { modelId: 'native' }, 'website-conversation')).rejects.toMatchObject({ code: 'invalid-request' });
        expect(observations).toBe(2);
    }, 20000);

});

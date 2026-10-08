import type { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import type { CapabilityCatalog, ExecutionBinding, GrantReceipt, ServiceErrorCode, ServiceRef } from '@slopus/happy-wire';
import type { AIServiceClient } from '../../../../paws-agent/dist/servicesNode.cjs';
import type { ServiceMessage } from '../../../../paws-agent/dist/servicesNode.cjs';
type InstalledSDK = typeof import('../../../../paws-agent/dist/servicesNode.cjs');
interface SmokeApp {
    url: string;
    client: AIServiceClient;
    close(): Promise<void>;
}
type ClaimedTurn = NonNullable<Awaited<ReturnType<ReturnType<typeof createSharedAIServices>['turns']['claim']>>>;
interface WorkerClaim {
    probe: {
        id: string;
        lease: string;
    } | null;
    job: ClaimedTurn | null;
}
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import type { Fastify } from '@/app/api/types';
const state = vi.hoisted(() => ({ database: null as unknown as PrismaClient }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: (_, key) => { const value = Reflect.get(state.database, key); return typeof value === 'function' ? value.bind(state.database) : value; } }) }));
import { createTestDatabase } from './testDatabase';
import { createSharedAIServices } from './composition';
import { createApplicationRegistry } from './registry';
import { aiServiceRoutes } from '@/app/api/routes/aiServiceRoutes';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
// This is server test infrastructure. The example imports public installed exports only.
const example = resolve('../../examples/ai-service-smoke');
let ctx: Awaited<ReturnType<typeof createTestDatabase>>, services: ReturnType<typeof createSharedAIServices>, app: Fastify, smoke: SmokeApp, sdk: InstalledSDK, token: string, url: string, service: ServiceRef;
let stopped = false, loop: Promise<void>, fault: ServiceErrorCode | null = null;
let workerFailure: unknown;
let policyBarrier: { requestId: string; entered: (job: ClaimedTurn) => void; resume: Promise<void>; release: () => void } | null = null;
const machineKeys = nacl.box.keyPair();
const owner = 'smoke-owner', machine = 'smoke-machine', receipts = new Map<string, GrantReceipt>(), clients = new Map<string, AIServiceClient>(), executions = new Map<string, number>();
const target = { machineId: machine, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: 'smoke-profile' } };
const config = { ...target, modelId: 'synthetic-a', reasoning: { mode: 'default' as const } };
const worker = (path: string, payload: object = {}) => app.inject({ method: 'POST', url: `/v1/ai-service-worker/${machine}/${path}`, payload, headers: { authorization: `Bearer ${token}` } });
const catalog = (): CapabilityCatalog => ({ ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'synthetic-a', models: ['synthetic-a', 'synthetic-b'].map(id => ({ id, name: id, supportsImages: false, reasoning: { supportsDefault: true, values: ['low', 'high'], defaultValue: 'low' } })) });
async function runWorker() {
    while (!stopped) {
        const claim = await worker('claim');
        if (claim.statusCode !== 200)
            throw new Error(claim.body);
        const { probe, job } = claim.json<WorkerClaim>();
        if (probe) {
            const response = await worker(`probes/${probe.id}`, { lease: probe.lease, catalog: catalog() });
            if (response.statusCode !== 200)
                throw new Error(response.body);
        }
        if (job) {
            const sealed = Buffer.from(job.envelope, 'base64'), opened = nacl.box.open(sealed.subarray(56), sealed.subarray(32, 56), sealed.subarray(0, 32), machineKeys.secretKey);
            if (!opened)
                throw new Error('Invalid synthetic worker envelope');
            const envelope: { grantId: string; appId: string; machineId: string; messageKey: string } = JSON.parse(Buffer.from(opened).toString());
            expect(envelope).toMatchObject({ grantId: job.grantId, appId: job.record.binding.appId, machineId: machine });
            const key = Buffer.from(envelope.messageKey, 'base64');
            const input = Buffer.from(job.input, 'base64'), plain = nacl.secretbox.open(input.subarray(24), input.subarray(0, 24), key);
            if (!plain)
                throw new Error('Invalid synthetic envelope');
            const messages: ServiceMessage[] = JSON.parse(Buffer.from(plain).toString()).messages;
            if (policyBarrier?.requestId === job.record.requestId) {
                const barrier = policyBarrier;
                barrier.entered(job);
                await barrier.resume;
            }
            const policy = await worker('policy', { kind: 'turn', id: job.record.id, lease: job.lease });
            if (policy.statusCode === 409 && policy.json().error?.code === 'execution-interrupted') {
                const cancelled = await ctx.database.appChatTurn.findUniqueOrThrow({ where: { id: job.record.id } });
                // Cancellation can win after claim but before policy. Acknowledge
                // only this lease; expired leases and other policy failures stay fatal.
                if (cancelled.state === 'cancel-requested' && cancelled.lease === job.lease) {
                    const response = await worker(`turns/${job.record.id}`, { lease: job.lease, status: 'cancelled' });
                    expect(response.statusCode, response.body).toBe(200);
                    continue;
                }
            }
            expect(policy.statusCode, policy.body).toBe(200);
            expect(policy.json().policy.appId).toBe(job.record.binding.appId);
            executions.set(job.record.id, (executions.get(job.record.id) || 0) + 1);
            if (messages.at(-1)!.text.includes('[slow]')) {
                for (let i = 0; i < 80; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    const row = await ctx.database.appChatTurn.findUniqueOrThrow({ where: { id: job.record.id } });
                    if (row.state === 'cancel-requested')
                        break;
                }
            }
            const row = await ctx.database.appChatTurn.findUniqueOrThrow({ where: { id: job.record.id } });
            const nonce = randomBytes(24), payload = { protocol: 'ai-services/1', grantId: job.grantId, appId: job.record.binding.appId, serviceId: service.id, bindingId: job.record.binding.id, requestId: job.record.requestId, turnId: job.record.id, direction: 'output', sequence: 1, text: '合成摘要：公开文本已收到。' };
            const output = Buffer.concat([nonce, nacl.secretbox(Buffer.from(JSON.stringify(payload)), nonce, key)]).toString('base64');
            const response = await worker(`turns/${job.record.id}`, { lease: job.lease, ...(row.state === 'cancel-requested' ? { status: 'cancelled' } : fault ? { status: 'failed', error: { code: fault, retryable: false } } : { status: 'completed', output, sequence: 1, actual: { modelId: null, reasoning: null } }) });
            expect(response.statusCode, response.body).toBe(200);
        }
        await new Promise(r => setTimeout(r, 15));
    }
}
async function settle(client: AIServiceClient, binding: ExecutionBinding, requestId: string) { for (let i = 0; i < 150; i++) {
    if (workerFailure) throw workerFailure;
    const value = await client.turns.read({ bindingId: binding.id, requestId });
    if (['completed', 'cancelled', 'failed', 'interrupted'].includes(value.record.status))
        return value;
    await new Promise(r => setTimeout(r, 20));
} throw new Error('Turn did not settle'); }
beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'synthetic-smoke-only';
    await initEncrypt();
    await auth.init();
    ctx = await createTestDatabase();
    state.database = ctx.database;
    services = createSharedAIServices(ctx.database);
    await ctx.database.account.create({ data: { id: owner, publicKey: owner } });
    await ctx.database.machine.create({ data: { id: machine, accountId: owner, metadata: 'synthetic' } });
    await ctx.database.codexAccountProfile.create({ data: { id: target.accountRef.id, accountId: owner, displayName: 'Synthetic', externalAccountFingerprint: 'synthetic', credential: Buffer.from('not-a-credential') } });
    app = fastify() as unknown as Fastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    aiServiceRoutes(app, services.store, services);
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port;
    token = await auth.createToken(owner);
    expect((await worker('announce', { protocol: 'ai-services/1', nativeSessions: true, publicKey: Buffer.from(machineKeys.publicKey).toString('base64') })).statusCode).toBe(200);
    loop = runWorker().catch(error => { workerFailure = error; });
    service = await services.store.createService(owner, { name: 'Synthetic shared service', config });
    const registry = createApplicationRegistry(ctx.database), businessPrompt = { id: 'smoke-summary', version: '1' };
    await registry.registerBusinessPrompt(businessPrompt, '请用一句话概括公开测试文本。');
    await registry.registerApplication({ appId: 'ai-service-smoke', name: 'Second application', origins: ['http://127.0.0.1:4193'], capabilities: ['chat'], businessPrompt });
    sdk = await import(pathToFileURL(createRequire(resolve(example, 'package.json')).resolve('@wangjs-jacky/paws-agent/services/node')).href);
    for (const appId of ['relationship-advisor', 'ai-service-smoke']) {
        const receipt = await services.grants.issueServiceGrant(owner, appId, service.id, { appId, serviceId: service.id, targets: [target], permissions: ['chat'], expiresAt: null });
        receipts.set(appId, receipt);
        const client = sdk.createAIServiceClient({ appId, transport: sdk.createNodePlatformTransport({ appId, serverUrl: url, receipt, storage: sdk.createMemoryServiceStorage() }) });
        await client.connections.authorize();
        clients.set(appId, client);
    }
    const { startSmokeApp } = await import(pathToFileURL(resolve(example, 'server.mjs')).href);
    smoke = await startSmokeApp({ serverUrl: url, receipt: receipts.get('ai-service-smoke')!, port: process.env.PAWS_SMOKE_SERVE === '1' ? 4193 : 0 });
}, 120000);
afterAll(async () => {
    stopped = true;
    policyBarrier?.release();
    try {
        await loop;
        if (workerFailure) throw workerFailure;
    } finally {
        await smoke?.close();
        for (const c of clients.values()) c.dispose();
        await app?.close(); await ctx?.database.$disconnect(); await ctx?.pg.close();
    }
});
// These HTTP + PGlite integration flows share CI CPU with the other workspaces.
// Match the transport integration budget without retrying failed assertions.
it('executes both packaged applications and rejects foreign bindings, owner APIs, origins and tool permissions', async () => {
    const advisor = clients.get('relationship-advisor')!, second = clients.get('ai-service-smoke')!;
    const first = await advisor.conversations.create({ appConversationId: 'advisor-only' });
    const binding = await second.conversations.create({ appConversationId: 'second-only' });
    for (const [client, b] of [[advisor, first], [second, binding]] as const) {
        await client.turns.start({ binding: b, requestId: 'one', messages: [{ role: 'user', text: 'Public synthetic input' }] });
        const result = await settle(client, b, 'one');
        expect(result.record.actual).toEqual({ modelId: null, reasoning: null });
        expect(result.text).toContain('合成摘要');
        expect(executions.get(result.record.id)).toBe(1);
    }
    const credential = receipts.get('ai-service-smoke')!.credential;
    for (const path of [`/v1/apps/ai-services/bindings/${first.id}`, `/v1/apps/ai-services/bindings/${first.id}/requests/one`])
        expect((await fetch(url + path, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(403);
    expect((await fetch(url + '/v1/ai-services', { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    expect((await fetch(url + '/v1/apps/services', { headers: { authorization: `Bearer ${credential}`, origin: 'https://foreign.example' } })).status).toBe(403);
    await expect(second.conversations.create({ overrides: { permissions: ['terminal' as never] } })).rejects.toMatchObject({ code: 'invalid-request' });
    expect((await second.conversations.find('advisor-only'))).toBeNull();
}, 20_000);
it('keeps old bindings while new defaults change and rejects unsupported reasoning', async () => {
    const client = clients.get('ai-service-smoke')!, old = await client.conversations.create({ appConversationId: 'old-default' });
    await services.store.updateService(owner, service.id, 1, { ...config, modelId: 'synthetic-b', reasoning: { mode: 'explicit', value: 'high' } });
    const next = await client.conversations.create({ appConversationId: 'new-default' });
    expect(old.revision).toBe(1);
    expect(old.requestedModel).toBe('synthetic-a');
    expect(next.revision).toBe(2);
    expect(next.requestedModel).toBe('synthetic-b');
    expect((await client.conversations.find('old-default'))!.id).toBe(old.id);
    await expect(client.conversations.create({ overrides: { reasoning: { mode: 'explicit', value: 'unsupported' } } })).rejects.toMatchObject({ code: 'parameter-unsupported' });
}, 20_000);
it('recovers before and after acceptance losses with zero duplicate executions, and fences cancellation', async () => {
    const client = clients.get('ai-service-smoke')!, binding = await client.conversations.create({ appConversationId: 'recovery' });
    for (const phase of ['before', 'after']) {
        let lost = false, posts = 0;
        const transport = sdk.createNodePlatformTransport({ appId: 'ai-service-smoke', serverUrl: url, receipt: receipts.get('ai-service-smoke')!, storage: sdk.createMemoryServiceStorage(), fetch: async (input, init) => {
                if (init?.method === 'POST' && String(input).endsWith('/turns')) {
                    posts++;
                    if (!lost) {
                        lost = true;
                        if (phase === 'after')
                            await fetch(input, init);
                        throw new Error('Injected lost response');
                    }
                }
                return fetch(input, init);
            } });
        const recovering = sdk.createAIServiceClient({ appId: 'ai-service-smoke', transport });
        await recovering.connections.authorize();
        const input = { binding, requestId: 'loss-' + phase, messages: [{ role: 'user' as const, text: 'Same original input' }] };
        await expect(recovering.turns.start(input)).rejects.toMatchObject({ code: 'transport-error' });
        await recovering.turns.start(input);
        const result = await settle(recovering, binding, input.requestId);
        expect(posts).toBe(phase === 'before' ? 2 : 1);
        expect(executions.get(result.record.id)).toBe(1);
        recovering.dispose();
    }
    const start = await client.turns.start({ binding, requestId: 'stop-race', messages: [{ role: 'user', text: '[slow]' }] });
    await client.turns.cancel({ bindingId: binding.id, turnId: start.record.id });
    const final = await settle(client, binding, 'stop-race');
    expect(final.record.status).toBe('cancelled');
    expect(executions.get(final.record.id) || 0).toBeLessThanOrEqual(1);
}, 20_000);
it('settles cancellation between claim and policy without execution and keeps the worker available', async () => {
    const client = clients.get('ai-service-smoke')!;
    const binding = await client.conversations.create({ appConversationId: 'cancel-before-policy' });
    let entered!: (job: ClaimedTurn) => void, release!: () => void;
    const claimed = new Promise<ClaimedTurn>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    policyBarrier = { requestId: 'cancel-before-policy', entered, resume, release };
    try {
        const start = await client.turns.start({ binding, requestId: 'cancel-before-policy', messages: [{ role: 'user', text: 'Cancel before execution' }] });
        const job = await claimed;
        expect(job.record.id).toBe(start.record.id);
        await client.turns.cancel({ bindingId: binding.id, turnId: start.record.id });
        expect(await ctx.database.appChatTurn.findUniqueOrThrow({ where: { id: start.record.id } })).toMatchObject({ state: 'cancel-requested', lease: job.lease });
        const policy = await worker('policy', { kind: 'turn', id: job.record.id, lease: job.lease });
        expect(policy.statusCode).toBe(409);
        expect(policy.json()).toEqual({ error: { code: 'execution-interrupted', retryable: false } });
        release();
        const cancelled = await settle(client, binding, 'cancel-before-policy');
        expect(cancelled.record.status).toBe('cancelled');
        expect(executions.get(start.record.id) || 0).toBe(0);
        await client.turns.start({ binding, requestId: 'after-policy-cancellation', messages: [{ role: 'user', text: 'Worker still available' }] });
        const next = await settle(client, binding, 'after-policy-cancellation');
        expect(next.record.status).toBe('completed');
        expect(executions.get(next.record.id)).toBe(1);
    } finally {
        release();
        policyBarrier = null;
    }
}, 20_000);
it('fails closed for offline, login loss, quota and revocation without changing payer or binding', async () => {
    const client = clients.get('ai-service-smoke')!, binding = await client.conversations.create({ appConversationId: 'failures' });
    await ctx.database.appChatWorker.update({ where: { machineId: machine }, data: { activeUntil: new Date(0) } });
    await expect(client.turns.start({ binding, requestId: 'offline', messages: [{ role: 'user', text: 'Offline' }] })).rejects.toMatchObject({ code: 'machine-offline', submission: 'not-submitted', requestId: 'offline' });
    await worker('announce', { protocol: 'ai-services/1', nativeSessions: true, publicKey: Buffer.from(machineKeys.publicKey).toString('base64') });
    fault = 'quota-exhausted';
    await client.turns.start({ binding, requestId: 'quota', messages: [{ role: 'user', text: 'Quota' }] });
    const quota = await settle(client, binding, 'quota');
    fault = null;
    expect(quota.record.error!.code).toBe('quota-exhausted');
    expect(quota.record.binding).toEqual(binding);
    await ctx.database.codexAccountProfile.update({ where: { id: target.accountRef.id }, data: { status: 'invalid' } });
    await expect(client.turns.start({ binding, requestId: 'login', messages: [{ role: 'user', text: 'Login' }] })).rejects.toMatchObject({ code: 'account-login-required', submission: 'not-submitted', requestId: 'login' });
    await ctx.database.codexAccountProfile.update({ where: { id: target.accountRef.id }, data: { status: 'available' } });
    // Revoke the independent advisor grant. Keep second-app browser acceptance usable.
    await services.store.revokeAuthorization(owner, receipts.get('relationship-advisor')!.id);
    await expect(clients.get('relationship-advisor')!.services.list()).rejects.toMatchObject({ code: 'authorization-revoked' });
    expect(await ctx.database.appChatTurn.count({ where: { requestId: { in: ['offline', 'login'] } } })).toBe(0);
}, 20_000);
it('serves a real packaged panel and bridge without exposing the platform receipt', async () => {
    const page = await fetch(smoke.url), cookie = page.headers.get('set-cookie')!.split(';')[0];
    expect(await page.text()).toContain('第二应用');
    const bundle = await fetch(smoke.url + '/bundle.js');
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).not.toContain(receipts.get('ai-service-smoke')!.credential);
    const headers = { cookie, 'X-Smoke-App': 'ai-service-smoke' };
    const connection = await fetch(smoke.url + '/api/service/connection', { headers });
    expect(connection.status).toBe(200);
    expect(await connection.text()).not.toContain('messageKey');
    expect((await fetch(smoke.url + '/api/service/connection')).status).toBe(403);
    console.log('Synthetic second app: ' + smoke.url + ' (actual routes; no native provider).');
}, 20_000);
it.skipIf(process.env.PAWS_SMOKE_SERVE !== '1')('holds the isolated browser fixture open', async () => {
    // Keep announcements alive while the controller operates the public synthetic page.
    const keepAlive = setInterval(async () => {
        const response = await worker('announce', { protocol: 'ai-services/1', nativeSessions: true, publicKey: Buffer.from(machineKeys.publicKey).toString('base64') });
        expect(response.statusCode, response.body).toBe(200);
    }, 10000);
    console.log('Browser fixture ready: http://127.0.0.1:4193/');
    await new Promise(resolve => setTimeout(resolve, 46000));
    const healthy = await app.inject({ method: 'GET', url: '/v1/ai-services/workers', headers: { authorization: `Bearer ${token}` } });
    expect(healthy.json().workers.map((value: {
        machineId: string;
    }) => value.machineId)).toContain(machine);
    const binding = await smoke.client.conversations.create({ appConversationId: 'idle-over-45-seconds' });
    await smoke.client.turns.start({ binding, requestId: 'after-idle', messages: [{ role: 'user', text: 'Public idle liveness check' }] });
    expect((await settle(smoke.client, binding, 'after-idle')).record.status).toBe('completed');
    console.log('Serve idle liveness: actual announce, binding and turn passed after 46 seconds.');
    await new Promise<void>(resolve => process.once('SIGINT', () => resolve()));
    clearInterval(keepAlive);
}, 3600000);

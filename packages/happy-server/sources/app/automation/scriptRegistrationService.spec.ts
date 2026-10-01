import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { decryptScriptValue, encryptScriptValue, type ScriptRegistrationRequest } from '@slopus/happy-wire';
import { markScriptReady, enqueueScriptInput, enqueueDueScript, scriptQueueInTransaction, validateScriptTarget } from './scriptExecutionService';
import { saveScriptAutomation } from './scriptRegistrationService';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { scriptAutomationRoutes } from '../api/routes/scriptAutomationRoutes';
import { listAutomations, requestAutomationRun, updateAutomation } from './automationService';
import { claimAutomationRun, syncAutomations } from './automationExecutionService';
import { hashScriptInput, signScriptServiceToken, type ScriptServiceOperation } from '@slopus/happy-wire/scriptServiceToken';

let sql: string;
let db: PGlite;
let client: PrismaClient;
const pair = nacl.box.keyPair();
const context = { projectId: 'p1', resourceId: 'collect', purpose: 'configuration' as const };
const registration: ScriptRegistrationRequest = {
  registrationKey: 'collect', expectedRevision: 0, paused: false, viewerKeyVersion: 1, machineKeyVersion: 1,
  encrypted: encryptScriptValue({ value: {}, context, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }),
  admission: { artifactId: 'code-1', digest: 'a'.repeat(64), schedule: null, externalEnabled: false, inputSchema: {} },
  artifact: encryptScriptValue({ value: { source: 'test' }, context: { ...context, resourceId: 'code-1', purpose: 'artifact' }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }),
};
beforeAll(async () => {
  const require = createRequire(resolve('package.json'));
  sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
  db = new PGlite(); await db.exec(sql);
  client = new PrismaClient({ adapter: new PrismaPGlite(db) });
  await client.account.createMany({ data: [{ id: 'owner', publicKey: 'owner' }, { id: 'viewer', publicKey: 'viewer' }] });
  await client.project.create({ data: { id: 'p1', accountId: 'owner', name: 'Project', config: { machineId: 'machine' }, automationViewerPublicKey: new Uint8Array(pair.publicKey), automationViewerKeyVersion: 1 } });
  await client.machine.create({ data: { id: 'machine', accountId: 'owner', metadata: '', automationPublicKey: new Uint8Array(pair.publicKey), automationKeyVersion: 1, automationProtocolVersion: 5 } });
});
afterEach(async () => { await client?.$disconnect(); await db?.close(); });

it('atomically registers an encrypted artifact and automation with idempotent registration', async () => {
  const first = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  const again = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  expect(again.id).toBe(first.id);
  expect(again.payloadVersion).toBe(3);
  expect(await client.automation.count()).toBe(1);
  expect(await client.scriptAutomationRevision.count({ where: { ready: false } })).toBe(1);
  expect(await client.automationChange.count()).toBe(0);
});
it('removes an unused previous revision and its artifact after a successful edit', async () => {
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  const artifactId = 'code-2';
  const changed = { ...registration, expectedRevision: 1,
    admission: { ...registration.admission, artifactId, digest: 'b'.repeat(64) },
    artifact: encryptScriptValue({ value: { source: 'changed' }, context: { ...context, resourceId: artifactId, purpose: 'artifact' }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }) };
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', changed));
  expect(await client.scriptAutomationRevision.findMany({ select: { revision: true, artifactId: true } }))
    .toEqual([{ revision: 2, artifactId }]);
  expect(await client.scriptArtifact.findMany({ select: { id: true } })).toEqual([{ id: artifactId }]);
});
it('requires the current machine and verified revision before manual admission, validates input and seals it for that run', async () => {
  const config = { ...registration, admission: { ...registration.admission, inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } } };
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  const enqueue = (input: Record<string, unknown>) => client.$transaction((tx) => enqueueScriptInput(tx, 'owner', 'p1', row.id, { input }, 'manual-1', 2000));
  await expect(enqueue({ count: 1 })).rejects.toThrow('REVISION_NOT_READY');
  await expect(client.$transaction((tx) => markScriptReady(tx, 'owner', 'other', row.id, 1, 1000))).rejects.toThrow('MACHINE_DENIED');
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  await expect(enqueue({ count: '1' })).rejects.toThrow('INPUT_SCHEMA_INVALID');
  await expect(enqueue({ count: 1, command: 'override' })).rejects.toThrow('INPUT_SCHEMA_INVALID');
  const run = await enqueue({ count: 1 });
  expect(run.status).toBe('QUEUED');
  expect(decryptScriptValue({ encrypted: JSON.parse(run.inputCiphertext), context: { projectId: 'p1', resourceId: run.id, purpose: 'input' }, recipient: 'machine', secretKey: pair.secretKey })).toEqual({ count: 1 });
  expect((await enqueue({ count: 1 })).id).toBe(run.id);
  await expect(enqueue({ count: 2 })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await client.machine.update({ where: { accountId_id: { accountId: 'owner', id: 'machine' } }, data: { automationKeyVersion: 2 } });
  await expect(client.$transaction((tx) => validateScriptTarget(tx, row.id, 'owner', 'machine'))).rejects.toThrow('KEY_VERSION_CONFLICT');
});
it('coalesces overdue schedules once and commits the cursor only with durable admission', async () => {
  const config = { ...registration, admission: { ...registration.admission, schedule: { kind: 'interval' as const, minutes: 15, enabled: true } } };
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 9999));
  expect((await client.scriptAutomationRevision.findFirstOrThrow()).nextRunAt).toBe(901000);
  const tick = () => client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', row.id, 2701000));
  const runs = await Promise.all([tick(), tick()]);
  expect(runs.filter(Boolean)).toHaveLength(1);
  expect(runs.find(Boolean)).toMatchObject({ trigger: 'SCHEDULE', scheduledFor: 901000, missedCount: 2 });
  expect((await client.scriptAutomationRevision.findFirstOrThrow()).nextRunAt).toBe(3601000);
  await client.automation.update({ where: { id: row.id }, data: { paused: true } });
  expect(await client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', row.id, 4501000))).toBeNull();
  expect((await client.scriptAutomationRevision.findFirstOrThrow()).nextRunAt).toBe(3601000);
});
it('rejects unauthorized actors, unsupported machines and stale key versions before storage', async () => {
  await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'viewer', 'p1', registration))).rejects.toThrow('PROJECT_WRITE_DENIED');
  await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...registration, machineKeyVersion: 2 }))).rejects.toThrow('KEY_VERSION_CONFLICT');
  await client.machine.update({ where: { id: 'machine' }, data: { automationProtocolVersion: 4 } });
  await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration))).rejects.toThrow('SCRIPT_RUNNER_UNSUPPORTED');
  expect(await client.automation.count()).toBe(0);
  expect(await client.scriptArtifact.count()).toBe(0);
});
it('rejects unsupported input schemas and schedules whose empty input cannot validate before registration', async () => {
  const admissions: ScriptRegistrationRequest['admission'][] = [
    { ...registration.admission, inputSchema: { $ref: 'https://example.invalid/schema.json' } },
    { ...registration.admission, schedule: { kind: 'interval' as const, minutes: 15, enabled: true }, inputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } },
  ];
  for (const admission of admissions) await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...registration, admission }))).rejects.toThrow('INPUT_SCHEMA_INVALID');
  expect(await client.automation.count()).toBe(0);
});
it('adds a code revision without invalidating accepted snapshots and rejects stale editors', async () => {
  const first = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', first.id, 1, 1000));
  await client.$transaction((tx) => enqueueScriptInput(tx, 'owner', 'p1', first.id, { input: {} }, 'retained-revision', 1001));
  const changed = { ...registration, expectedRevision: 1, encrypted: encryptScriptValue({ value: { changed: true }, context, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }) };
  const second = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', changed));
  expect(second.revision).toBe(2);
  expect(second.generation).toBe(first.generation);
  expect(await client.scriptAutomationRevision.count()).toBe(2);
  await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', changed))).rejects.toThrow('REVISION_CONFLICT');
});

it('registers and reads the same encrypted automation through authenticated HTTP routes', async () => {
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  try {
    const saved = await app.inject({ method: 'POST', url: '/v1/projects/p1/script-automations', payload: registration });
    expect(saved.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/v1/projects/p1/script-automations' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().automations[0].id).toBe(saved.json().automation.id);
    expect(listed.json().automations[0]).toMatchObject({ registrationKey: 'collect', ready: false, encrypted: registration.encrypted });
    const foreign = await app.inject({ method: 'GET', url: '/v1/projects/other/script-artifacts/code-1' });
    expect(foreign.statusCode).toBe(404);
    const id = saved.json().automation.id;
    const poll = await app.inject({ method: 'GET', url: '/v1/machines/machine/script-automations' });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().automations[0]).not.toHaveProperty('artifact');
    expect(poll.json().automations[0]).not.toHaveProperty('encrypted');
    expect(poll.json().automations[0]).not.toHaveProperty('admission');
    const artifact = await app.inject({ method: 'GET', url: `/v1/machines/machine/script-automations/${id}/artifact` });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toMatchObject({ encrypted: registration.encrypted, admission: registration.admission });
    expect(artifact.json().artifact.encrypted).toEqual(registration.artifact);
    expect((await app.inject({ method: 'GET', url: `/v1/machines/other/script-automations/${id}/artifact` })).statusCode).toBe(403);
    const ready = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${id}/ready`, payload: { revision: 1 } });
    expect(ready.statusCode).toBe(200);
    const submitted = await app.inject({ method: 'POST', url: `/v1/projects/p1/script-automations/${id}/runs`, headers: { 'idempotency-key': 'manual-http' }, payload: { input: {} } });
    expect(submitted.statusCode).toBe(202);
    const claimResponse = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${id}/claim`, payload: {} });
    expect(claimResponse.statusCode).toBe(200);
    const { claim } = claimResponse.json();
    expect(claim.run.id).toBe(submitted.json().runId);
    const denied = await app.inject({ method: 'POST', url: `/v1/machines/other/script-runs/${claim.run.id}/start`, payload: { token: claim.token } });
    expect(denied.statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-runs/${claim.run.id}/start`, payload: { token: claim.token } });
    expect(started.statusCode).toBe(200);
    const result = { token: claim.token, exitCode: 0, logCiphertext: JSON.stringify(registration.encrypted) };
    const completed = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-runs/${claim.run.id}/complete`, payload: result });
    expect(completed.statusCode).toBe(200);
    const recovered = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-runs/${claim.run.id}/abandon`, payload: { token: claim.token } });
    expect(recovered.statusCode).toBe(200);
    const history = await app.inject({ method: 'GET', url: `/v1/projects/p1/script-automations/${id}/runs` });
    expect(history.statusCode).toBe(200);
    expect(history.json().runs[0]).toMatchObject({ id: claim.run.id, status: 'COMPLETED', exitCode: 0 });
    expect(history.json().runs[0]).not.toHaveProperty('claimHash');
    expect(history.json().runs[0]).not.toHaveProperty('inputCiphertext');
    expect(history.json().runs[0]).not.toHaveProperty('logCiphertext');
    const log = await app.inject({ method: 'GET', url: `/v1/projects/p1/script-automations/${id}/runs/${claim.run.id}/log` });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toEqual({ logCiphertext: result.logCiphertext });
    expect((await app.inject({ method: 'GET', url: `/v1/projects/p1/script-automations/other/runs/${claim.run.id}/log` })).statusCode).toBe(404);
    await client.scriptAutomationRevision.update({ where: { automationId_revision: { automationId: id, revision: 1 } }, data: {
      admission: { ...registration.admission, schedule: { kind: 'at', at: 1, enabled: true } }, nextRunAt: 1,
    } });
    await client.$executeRawUnsafe(`INSERT INTO "ScriptInvocation" (id,"automationId",revision,generation,trigger,"requestedBy","idempotencyKey","bodyHash",snapshot,"inputCiphertext","createdAt")
      SELECT 'queued-'||n,"automationId",revision,generation,trigger,"requestedBy",'pending-'||n,"bodyHash",snapshot,"inputCiphertext",$2::double precision+n
      FROM "ScriptInvocation", generate_series(1,100) n WHERE id=$1`, claim.run.id, Date.now());
    const full = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${id}/claim`, payload: {} });
    expect(full.statusCode).toBe(200);
    expect(full.json().claim.run.id).toBe('queued-1');
    expect((await client.scriptAutomationRevision.findFirstOrThrow()).nextRunAt).toBeNull();
  } finally { await app.close(); }
});
it('hides missing and inaccessible projects behind the same NOT_FOUND on script read routes', async () => {
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'viewer'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  try {
    for (const projectId of ['missing', 'p1']) {
      const listed = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/script-automations` });
      expect(listed.statusCode).toBe(404);
      expect(listed.json()).toEqual({ error: 'NOT_FOUND' });
    }
  } finally { await app.close(); }
});

it('keeps script records out of legacy list, sync, update, run-now and claim paths', async () => {
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  expect(await client.$transaction((tx) => listAutomations(tx, 'owner', 'p1'))).toEqual({ ok: true, value: [] });
  expect(await client.$transaction((tx) => updateAutomation(tx, 'owner', 'p1', row.id, { expectedRevision: 1, paused: true })))
    .toMatchObject({ ok: false, error: 'invalid-payload-update' });
  expect(await client.$transaction((tx) => requestAutomationRun(tx, 'owner', 'p1', row.id, 1)))
    .toMatchObject({ ok: false, error: 'automation-run-unsupported' });
  await client.automationChange.create({ data: { automationId: row.id, revision: 1, generation: 1, machineId: 'machine', machineAccountId: 'owner', kind: 'UPSERT' } });
  const sync = await client.$transaction((tx) => syncAutomations(tx, 'owner', 'machine', { afterSeq: 0n, limit: 100 }));
  expect(sync).toMatchObject({ ok: true, value: { changes: [{ kind: 'TOMBSTONE', automationId: row.id }] } });
  expect(await client.$transaction((tx) => claimAutomationRun(tx, 'owner', 'machine', { automationId: row.id, generation: 1, scheduledFor: new Date() })))
    .toMatchObject({ ok: false, error: 'claim-denied' });
  expect((await client.automation.findUniqueOrThrow({ where: { id: row.id } })).revision).toBe(1);
});

it('accepts only scoped service admissions and returns only the requesting key’s run status', async () => {
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', {
    ...registration, admission: { ...registration.admission, externalEnabled: true },
  }));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, Date.now()));
  const secret = 'integration-service-secret'.repeat(2);
  const proof = (claims: ScriptServiceOperation) => signScriptServiceToken({ claims, secret, now: Date.now() });
  const scope = { projectId: 'p1', automationId: row.id };
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true, serviceSecret: () => secret });
  const base = `/v1/projects/p1/script-automations/${row.id}`;
  const expiresAt = Date.now() + 60000;
  try {
    for (const keyId of ['key-1', 'key-2']) {
      const synced = await app.inject({ method: 'POST', url: `${base}/key-sync`, payload: {
        serviceToken: proof({ ...scope, operation: 'key-sync', keyId, epoch: 1, revoked: false, expiresAt }),
      } });
      expect(synced.statusCode).toBe(200);
    }
    const claims = { ...scope, operation: 'enqueue' as const, keyId: 'key-1', epoch: 1, revision: 1, generation: row.generation,
      idempotencyKey: 'external-request', inputHash: hashScriptInput({ count: 1 }) };
    const submit = (input: Record<string, unknown>, serviceToken = proof(claims)) => app.inject({ method: 'POST', url: `${base}/external-runs`, payload: { serviceToken, input } });
    expect((await submit({ count: 2 })).statusCode).toBe(403);
    const accepted = await submit({ count: 1 });
    expect(accepted.statusCode).toBe(202);
    expect((await submit({ count: 1 })).json().runId).toBe(accepted.json().runId);
    expect((await submit({ count: 2 }, proof({ ...claims, inputHash: hashScriptInput({ count: 2 }) }))).statusCode).toBe(409);
    for (const keyId of ['key-1', 'key-2']) {
      const status = await app.inject({ method: 'POST', url: `${base}/external-runs/${accepted.json().runId}/status`, payload: {
        serviceToken: proof({ ...scope, operation: 'status', keyId, epoch: 1, runId: accepted.json().runId }),
      } });
      expect(status.statusCode).toBe(keyId === 'key-1' ? 200 : 404);
      if (keyId === 'key-1') {
        expect(status.json()).toMatchObject({ runId: accepted.json().runId, status: 'QUEUED' });
        expect(status.json()).not.toHaveProperty('inputCiphertext');
        expect(status.json()).not.toHaveProperty('logCiphertext');
      }
    }
    expect((await app.inject({ method: 'POST', url: `${base}/key-sync`, payload: { serviceToken: proof({ ...scope, operation: 'key-sync', keyId: 'key-1', epoch: 2, revoked: true, expiresAt }) } })).statusCode).toBe(200);
    expect((await submit({ count: 1 })).statusCode).toBe(403);
    expect((await client.scriptInvocation.findFirstOrThrow()).status).toBe('CANCELLED');
  } finally { await app.close(); }
});

it('requires a fresh scoped Studio execution proof after verifying the active claim context', async () => {
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, Date.now()));
  await client.$transaction((tx) => enqueueScriptInput(tx, 'owner', 'p1', row.id, { input: {} }, 'execution-proof', Date.now()));
  const secret = 'execution-service-secret'.repeat(2);
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true, serviceSecret: () => secret });
  try {
    const { claim } = (await app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${row.id}/claim`, payload: {} })).json();
    const base = `/v1/machines/machine/script-runs/${claim.run.id}`;
    const context = await app.inject({ method: 'POST', url: `${base}/context`, payload: { token: claim.token } });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ projectId: 'p1', automationId: row.id, runId: claim.run.id, machineId: 'machine', machineAccountId: 'owner', generation: row.generation });
    expect(context.json()).not.toHaveProperty('inputCiphertext');
    expect((await app.inject({ method: 'POST', url: `${base}/context`, payload: { token: 'x'.repeat(43) } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${base}/start`, payload: { token: claim.token } })).statusCode).toBe(403);
    const claims = { operation: 'execution' as const, projectId: 'p1', automationId: row.id, runId: claim.run.id, machineId: 'machine', machineAccountId: 'owner', generation: row.generation, runAsUserId: 'studio-user' };
    const signed = (runId: string) => signScriptServiceToken({ secret, now: Date.now(), claims: { ...claims, runId } });
    expect((await app.inject({ method: 'POST', url: `${base}/start`, payload: { token: claim.token, executionProof: signed('other') } })).statusCode).toBe(403);
    expect((await client.scriptInvocation.findUniqueOrThrow({ where: { id: claim.run.id } })).status).toBe('CLAIMED');
    expect((await app.inject({ method: 'POST', url: `${base}/start`, payload: { token: claim.token, executionProof: signed(claim.run.id) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${base}/context`, payload: { token: claim.token } })).statusCode).toBe(409);
  } finally { await app.close(); }
});

it.runIf(process.env.HAPPY_SCRIPT_DOCKER_TESTS === '1')('executes a scheduled HTTP invocation in the real CLI Docker worker without an agent session', async () => {
  const source = 'console.log(JSON.stringify({collected:3,uid:process.getuid()}));';
  const digest = createHash('sha256').update(source).digest('hex');
  const schedule = { kind: 'at' as const, at: Date.now() - 1000, enabled: true };
  const payload = { version: 3, name: 'Collect', schedule, externalEnabled: false, inputSchema: {}, action: {
    kind: 'script', runtime: 'node', artifactId: 'code-1', digest, entrypoint: 'collect.mjs', args: [], timeoutSeconds: 10, secretRefs: {}, allowedOrigins: [],
  } };
  const config = { ...registration, admission: { ...registration.admission, digest, schedule },
    encrypted: encryptScriptValue({ value: payload, context, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }),
    artifact: encryptScriptValue({ value: { source }, context: { ...context, resourceId: 'code-1', purpose: 'artifact' }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey }) };
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  const directory = await mkdtemp(resolve(tmpdir(), 'script-http-e2e-'));
  const cli = resolve('../happy-cli');
  const ownerId = randomBytes(32).toString('hex');
  const exec = promisify(execFile);
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const image = (await exec('docker', ['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}'])).stdout.trim();
    const configPath = resolve(directory, 'config.json');
    await writeFile(configPath, JSON.stringify({ url, image, ownerId, directory, secretKey: Array.from(pair.secretKey) }), { mode: 0o600 });
    const program = `import {readFile} from 'node:fs/promises';
import {createScriptAutomationWorker} from ${JSON.stringify(resolve(cli, 'src/daemon/automations/scriptAutomationWorker.ts'))};
import {prepareManagedScriptRuntime,recoverManagedScriptContainers} from ${JSON.stringify(resolve(cli, 'src/daemon/automations/managedScriptRuntime.ts'))};
import {runManagedScript} from ${JSON.stringify(resolve(cli, 'src/daemon/automations/managedScriptRunner.ts'))};
async function main(){
const c=JSON.parse(await readFile(process.argv[2],'utf8'));const temporaryRoot=c.directory+'/work';
await prepareManagedScriptRuntime({ownerId:c.ownerId,directory:temporaryRoot,image:c.image});
const worker=createScriptAutomationWorker({machineId:'machine',accountId:'owner',machineSecretKey:new Uint8Array(c.secretKey),image:c.image,directory:c.directory+'/outbox',log:console.error,
request:async(method,path,body)=>{const response=await fetch(c.url+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('HTTP '+response.status+' '+await response.text());return response.json()},
recoverContainers:()=>recoverManagedScriptContainers({ownerId:c.ownerId,directory:temporaryRoot}),execute:input=>runManagedScript({...input,ownerId:c.ownerId,temporaryRoot})});
await worker.tick();await worker.stop();}
main().catch(error=>{console.error(error);process.exitCode=1});`;
    const programPath = resolve(directory, 'worker.ts');
    await writeFile(programPath, program);
    const require = createRequire(resolve(cli, 'package.json'));
    await exec(process.execPath, [require.resolve('tsx/cli'), programPath, configPath], { cwd: cli, timeout: 45000, maxBuffer: 1024 * 1024 });
    const run = await client.scriptInvocation.findFirstOrThrow();
    expect(run).toMatchObject({ status: 'COMPLETED', trigger: 'SCHEDULE', exitCode: 0 });
    const logs = decryptScriptValue({ encrypted: JSON.parse(run.logCiphertext!), context: { projectId: 'p1', resourceId: run.id, purpose: 'log' }, recipient: 'viewer', secretKey: pair.secretKey }) as { log: string };
    expect(JSON.parse(logs.log)).toEqual({ collected: 3, uid: 65534 });
    expect(await client.session.count()).toBe(0);
    expect((await exec('docker', ['ps', '-aq', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim()).toBe('');
  } finally {
    const ids = (await exec('docker', ['ps', '-aq', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) await exec('docker', ['rm', '--force', ...ids]);
    const networks = (await exec('docker', ['network', 'ls', '-q', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim().split(/\s+/).filter(Boolean);
    for (const network of networks) await exec('docker', ['network', 'rm', network]);
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it('rejects direct company-token script mutations unless Studio signs that exact request', async () => {
  const secret = 'management-service-secret'.repeat(2);
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true, serviceSecret: () => secret });
  try {
    const url = '/v1/projects/p1/script-automations';
    expect((await app.inject({ method: 'POST', url, payload: registration })).statusCode).toBe(403);
    const { hashScriptManagementRequest, scriptAutomationId } = await import('@slopus/happy-wire/scriptServiceToken');
    const serviceToken = signScriptServiceToken({ secret, now: Date.now(), claims: { operation: 'management', projectId: 'p1',
      automationId: scriptAutomationId('p1', registration.registrationKey), action: 'upsert', requestHash: hashScriptManagementRequest(registration) } });
    expect((await app.inject({ method: 'POST', url, payload: { ...registration, paused: true, serviceToken } })).statusCode).toBe(403);
    expect(await client.automation.count()).toBe(0);
    expect((await app.inject({ method: 'POST', url, payload: { ...registration, serviceToken } })).statusCode).toBe(200);
  } finally { await app.close(); }
});

it.runIf(process.env.HAPPY_SCRIPT_DOCKER_TESTS === '1')('runs agent registration through Studio key ingress and Docker with execution permission rechecks', async () => {
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  const serviceSecret = randomBytes(32).toString('hex');
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true, serviceSecret: () => serviceSecret });
  app.get('/v1/projects/p1/automation-target', async () => ({ machineId: 'machine', automationProtocolVersion: 5, machineKeyVersion: 1, viewerKeyVersion: 1,
    viewerPublicKey: Buffer.from(pair.publicKey).toString('base64'), machinePublicKey: Buffer.from(pair.publicKey).toString('base64') }));
  const directory = await mkdtemp(resolve(tmpdir(), 'script-platform-e2e-'));
  const cli = resolve('../happy-cli');
  const ownerId = randomBytes(32).toString('hex');
  const exec = promisify(execFile);
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const image = (await exec('docker', ['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}'])).stdout.trim();
    const config = resolve(directory, 'config.json');
    await writeFile(config, JSON.stringify({ url, image, ownerId, directory, cli, web: resolve('../../../../packages/web-ui'), serviceSecret, secretKey: Array.from(pair.secretKey) }), { mode: 0o600 });
    const require = createRequire(resolve(cli, 'package.json'));
    const result = await exec(process.execPath, [require.resolve('tsx/cli'), resolve('sources/app/automation/scriptAutomationPlatform.fixture.mjs'), config], { cwd: cli, timeout: 60000, maxBuffer: 1024 * 1024 });
    expect(result.stdout).toContain('"completed":"COMPLETED"');
    expect(result.stdout).toContain('"revokedBeforeStart":"FAILED"');
    expect(await client.automation.count()).toBe(1);
    expect(await client.scriptInvocation.count({ where: { status: 'COMPLETED' } })).toBe(1);
    expect(await client.scriptInvocation.count({ where: { status: 'FAILED', failureCode: 'PROJECT_WRITE_DENIED' } })).toBe(1);
    expect(await client.session.count()).toBe(0);
    expect((await exec('docker', ['ps', '-aq', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim()).toBe('');
  } finally {
    const ids = (await exec('docker', ['ps', '-aq', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) await exec('docker', ['rm', '--force', ...ids]);
    const networks = (await exec('docker', ['network', 'ls', '-q', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim().split(/\s+/).filter(Boolean);
    for (const network of networks) await exec('docker', ['network', 'rm', network]);
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
}, 80000);

it('keeps reserved monitor v2 records in legacy inventory while isolating script v3', async () => {
  const script = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await client.automation.create({ data: { ...script, id: 'existing-monitor', payloadVersion: 2, scriptRegistrationKey: null } });
  const legacy = await client.$transaction((tx) => listAutomations(tx, 'owner', 'p1'));
  expect(legacy).toMatchObject({ ok: true, value: [{ id: 'existing-monitor', payloadVersion: 2 }] });
  const paused = await client.$transaction((tx) => updateAutomation(tx, 'owner', 'p1', 'existing-monitor', { expectedRevision: 1, paused: true }));
  expect(paused).toMatchObject({ ok: true });
});
it('exposes revision validation failures and clears them only after the current target verifies code', async () => {
  const { markScriptValidationFailed } = await import('./scriptExecutionService');
  const { serializeScriptAutomation } = await import('../api/routes/scriptAutomationRoutes');
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await expect(client.$transaction((tx) => markScriptValidationFailed(tx, 'owner', 'foreign', row.id, 1))).rejects.toThrow('MACHINE_DENIED');
  await client.$transaction((tx) => markScriptValidationFailed(tx, 'owner', 'machine', row.id, 1));
  const listed = await client.automation.findUniqueOrThrow({ where: { id: row.id }, include: { scriptRevisions: true, targetMachine: true, project: true } });
  expect(serializeScriptAutomation(listed)).toMatchObject({ ready: false, validationFailure: 'SCRIPT_REVISION_INVALID', machineOnline: true, machineLastActiveAt: expect.any(Number) });
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  expect(await client.scriptAutomationRevision.findFirstOrThrow()).toMatchObject({ ready: true, validationFailure: null });
});
it('rejects a registration retry with altered key envelopes even when ciphertext matches', async () => {
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  const replacement = encryptScriptValue({ value: {}, context, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey });
  await expect(client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...registration,
    encrypted: { ...registration.encrypted, viewerKeyEnvelope: replacement.viewerKeyEnvelope } }))).rejects.toThrow('REVISION_CONFLICT');
});

it('commits a cancelled claim before returning CLAIM_INVALID from the HTTP transaction', async () => {
  const now = Date.now();
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, now));
  await client.$transaction((tx) => enqueueScriptInput(tx, 'owner', 'p1', row.id, { input: {} }, 'cancel-before-start', now + 1));
  const queue = scriptQueueInTransaction(client as never);
  const claim = await queue.claim(row.id, 'owner', 'machine', now + 2);
  await client.automation.update({ where: { id: row.id }, data: { paused: true } });
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-runs/${claim!.run.id}/start`, payload: { token: claim!.token } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'CLAIM_INVALID' });
    expect((await client.scriptInvocation.findUniqueOrThrow({ where: { id: claim!.run.id } })).status).toBe('CANCELLED');
  } finally { await app.close(); }
});

it('returns an existing claim even when admitting the next due schedule would fail', async () => {
  const now = Date.now();
  const config = { ...registration, admission: { ...registration.admission, schedule: { kind: 'at' as const, at: now - 1, enabled: true } } };
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, now - 2));
  await client.$transaction((tx) => enqueueScriptInput(tx, 'owner', 'p1', row.id, { input: {} }, 'already-queued', now - 1));
  await client.machine.update({ where: { accountId_id: { accountId: 'owner', id: 'machine' } }, data: { automationPublicKey: new Uint8Array([1]) } });
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${row.id}/claim`, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().claim.run.id).toBe((await client.scriptInvocation.findFirstOrThrow({ where: { trigger: 'MANUAL' } })).id);
    expect((await client.scriptInvocation.findFirstOrThrow({ where: { trigger: 'MANUAL' } })).status).toBe('CLAIMED');
  } finally { await app.close(); }
});

it('does not replay a consumed one-shot after HTTP edits, schedule pause/resume and history retention', async () => {
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  const schedule = { kind: 'at' as const, at: 1000, enabled: true };
  const config = { ...registration, admission: { ...registration.admission, schedule } };
  try {
    const saved = await app.inject({ method: 'POST', url: '/v1/projects/p1/script-automations', payload: config });
    expect(saved.statusCode).toBe(200);
    const id = saved.json().automation.id;
    const ready = () => app.inject({ method: 'POST', url: `/v1/machines/machine/script-automations/${id}/ready`, payload: { revision } });
    let revision = 1;
    expect((await ready()).statusCode).toBe(200);
    expect(await client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', id, 2000))).toMatchObject({ trigger: 'SCHEDULE' });
    await client.scriptInvocation.deleteMany();
    for (const enabled of [true, false, true]) {
      const edit = await app.inject({ method: 'POST', url: '/v1/projects/p1/script-automations', payload: {
        ...config, expectedRevision: revision, admission: { ...config.admission, schedule: { ...schedule, enabled } },
      } });
      expect(edit.statusCode).toBe(200);
      revision++;
      await client.scriptAutomationRevision.deleteMany({ where: { automationId: id, revision: { lt: revision } } });
      expect((await ready()).statusCode).toBe(200);
      expect(await client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', id, 3000))).toBeNull();
    }
    expect(await client.scriptInvocation.count()).toBe(0);
  } finally { await app.close(); }
});
it('preserves an interval cursor across edits but initializes a changed schedule', async () => {
  const config = { ...registration, admission: { ...registration.admission, schedule: { kind: 'interval' as const, minutes: 15, enabled: true } } };
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...config, expectedRevision: 1 }));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 2, 10000));
  expect(await client.scriptAutomationRevision.findUniqueOrThrow({ where: { automationId_revision: { automationId: row.id, revision: 2 } } })).toMatchObject({ nextRunAt: 901000 });
  await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...config, expectedRevision: 2,
    admission: { ...config.admission, schedule: { kind: 'at', at: 20000, enabled: true } } }));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 3, 15000));
  expect(await client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', row.id, 20000))).toMatchObject({ scheduledFor: 20000 });
});
it('returns a manual HTTP retry after a schema edit and still rejects a changed body', async () => {
  const app = fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'owner'; });
  scriptAutomationRoutes(app, { transaction: (action) => client.$transaction(action), enabled: () => true });
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', registration));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  const submit = (input: Record<string, unknown>, key = 'retry-edit') => app.inject({ method: 'POST', url: `/v1/projects/p1/script-automations/${row.id}/runs`, headers: { 'idempotency-key': key }, payload: { input } });
  try {
    const first = await submit({ count: 1 });
    expect(first.statusCode).toBe(202);
    await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', { ...registration, expectedRevision: 1,
      admission: { ...registration.admission, inputSchema: { type: 'object', additionalProperties: false } } }));
    const retry = await submit({ count: 1 });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().runId).toBe(first.json().runId);
    expect((await submit({ count: 2 })).statusCode).toBe(409);
    expect((await submit({ count: 1 }, 'new-request')).statusCode).toBe(409);
    await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 2, 2000));
    expect((await submit({ count: 1 }, 'new-request')).statusCode).toBe(422);
    expect(await client.scriptInvocation.count()).toBe(1);
  } finally { await app.close(); }
});

it('retains a disabled schedule cursor internally while hiding its next execution in admin', async () => {
  const { serializeScriptAutomation } = await import('../api/routes/scriptAutomationRoutes');
  const config = { ...registration, admission: { ...registration.admission, schedule: { kind: 'at' as const, at: 10000, enabled: false } } };
  const row = await client.$transaction((tx) => saveScriptAutomation(tx, 'owner', 'p1', config));
  await client.$transaction((tx) => markScriptReady(tx, 'owner', 'machine', row.id, 1, 1000));
  const listed = await client.automation.findUniqueOrThrow({ where: { id: row.id }, include: { scriptRevisions: true, targetMachine: true, project: true } });
  expect(listed.scriptRevisions[0].nextRunAt).toBe(10000);
  expect(serializeScriptAutomation(listed).nextRunAt).toBeNull();
  expect(await client.$transaction((tx) => enqueueDueScript(tx, 'owner', 'machine', row.id, 20000))).toBeNull();
});

import * as z from 'zod';
import type { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { scriptAdmissionSchema, scriptEncryptedValueSchema, scriptRegistrationRequestSchema, scriptInvocationRequestSchema } from '@slopus/happy-wire';
import { verifyScriptServiceToken, hashScriptManagementRequest, scriptAutomationId, type ScriptServiceOperation } from '@slopus/happy-wire/scriptServiceToken';
import type { Fastify } from '../types';
import { inTx } from '@/storage/inTx';
import { projectAccess } from '@/app/automation/automationService';
import { saveScriptAutomation } from '@/app/automation/scriptRegistrationService';
import { createScriptArtifactService } from '@/app/automation/scriptArtifactService';
import { enqueueDueScript, enqueueScriptApiInput, enqueueScriptInput, markScriptReady, markScriptValidationFailed, scriptQueueInTransaction, validateScriptTarget } from '@/app/automation/scriptExecutionService';

export type ScriptRouteDependencies = {
  transaction<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  enabled(): boolean;
  serviceSecret?(): string | undefined;
};
const projectParams = z.strictObject({ projectId: z.string().min(1).max(200) });
const identifier = z.string().min(1).max(200);
const automationParams = projectParams.extend({ automationId: identifier });
const machineParams = z.strictObject({ machineId: identifier });
const machineAutomationParams = machineParams.extend({ automationId: identifier });
const runParams = machineParams.extend({ runId: identifier });
const claimBody = z.strictObject({ token: z.string().min(40).max(100) });
const includes = { scriptRevisions: { orderBy: { revision: 'desc' as const }, take: 1 }, targetMachine: true, project: true } as const;
type ScriptRow = Prisma.AutomationGetPayload<{ include: typeof includes }>;

export function serializeScriptAutomation(row: ScriptRow) {
  const revision = row.scriptRevisions[0];
  if (!revision || revision.revision !== row.revision) throw new Error('SCRIPT_REVISION_MISSING');
  const admission = scriptAdmissionSchema.parse(revision.admission);
  return {
    id: row.id, projectId: row.projectId, registrationKey: row.scriptRegistrationKey,
    revision: row.revision, generation: row.generation, paused: row.paused, machineId: row.machineId,
    machineAccountId: row.machineAccountId, machineKeyVersion: row.machineKeyVersion, viewerKeyVersion: row.viewerKeyVersion,
    machinePublicKey: row.targetMachine?.automationPublicKey ? Buffer.from(row.targetMachine.automationPublicKey).toString('base64') : null,
    viewerPublicKey: row.project.automationViewerPublicKey ? Buffer.from(row.project.automationViewerPublicKey).toString('base64') : null,
    encrypted: scriptEncryptedValueSchema.parse(JSON.parse(revision.payloadCiphertext)),
    admission, ready: revision.ready, nextRunAt: revision.ready && !row.paused && admission.schedule?.enabled ? revision.nextRunAt : null,
    validationFailure: revision.validationFailure, machineOnline: row.targetMachine?.active ?? false,
    machineLastActiveAt: row.targetMachine?.lastActiveAt.getTime() ?? null,
    createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
  };
}

export function scriptAutomationRoutes(app: Fastify, dependencies: ScriptRouteDependencies = {
  transaction: inTx,
  enabled: () => process.env.HAPPY_SCRIPT_AUTOMATIONS_ENABLED === '1' && !!process.env.SCRIPT_AUTOMATION_ADMISSION_SECRET,
  serviceSecret: () => process.env.SCRIPT_AUTOMATION_ADMISSION_SECRET,
}) {
  function proof<T extends ScriptServiceOperation['operation']>(token: string, operation: T, scope: { projectId: string; automationId: string }) {
    const secret = dependencies.serviceSecret?.();
    if (!secret) throw new Error('SCRIPT_SERVICE_SECRET_REQUIRED');
    const claims = verifyScriptServiceToken({ token, operation, ...scope, secret, now: Date.now() });
    if (!claims) throw new Error('SCRIPT_SERVICE_PROOF_INVALID');
    return claims;
  }
  function managementProof(token: string | undefined, scope: { projectId: string; automationId: string }, action: 'upsert' | 'run' | 'cancel', request: unknown) {
    if (!dependencies.serviceSecret?.()) return;
    const claims = proof(token ?? '', 'management', scope);
    if (claims.action !== action || claims.requestHash !== hashScriptManagementRequest(request)) throw new Error('SCRIPT_SERVICE_PROOF_INVALID');
  }
  async function handle(reply: FastifyReply, action: () => Promise<unknown>) {
    if (!dependencies.enabled()) return reply.code(404).send({ error: 'SCRIPT_AUTOMATIONS_DISABLED' });
    try { return await action(); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['PROJECT_WRITE_DENIED', 'MACHINE_DENIED', 'SCRIPT_SERVICE_PROOF_INVALID', 'KEY_REVOKED'].includes(code)) return reply.code(403).send({ error: code });
      if (code === 'SCRIPT_SERVICE_SECRET_REQUIRED') return reply.code(503).send({ error: code });
      if (code === 'ARTIFACT_NOT_FOUND' || code === 'NOT_FOUND') return reply.code(404).send({ error: code });
      if (code === 'INPUT_SCHEMA_INVALID' || error instanceof z.ZodError) return reply.code(422).send({ error: 'INPUT_SCHEMA_INVALID' });
      if (code === 'INPUT_TOO_LARGE') return reply.code(413).send({ error: code });
      if (code === 'QUEUE_FULL' || code === 'RATE_LIMITED') return reply.code(429).send({ error: code });
      if (['REVISION_CONFLICT', 'KEY_VERSION_CONFLICT', 'SCRIPT_RUNNER_UNSUPPORTED', 'SCRIPT_REVISION_MISSING',
        'ARTIFACT_IMMUTABLE', 'REVISION_IMMUTABLE', 'ARTIFACT_DIGEST_MISMATCH', 'REVISION_NOT_READY', 'AUTOMATION_PAUSED',
        'IDEMPOTENCY_CONFLICT', 'CLAIM_INVALID', 'REPORT_CONFLICT', 'KEY_EPOCH_CONFLICT', 'EXTERNAL_DISABLED'].includes(code)) return reply.code(409).send({ error: code });
      app.log.error({ err: error }, 'Script automation storage operation failed');
      return reply.code(500).send({ error: 'SCRIPT_STORAGE_FAILED' });
    }
  }

  app.post('/v1/projects/:projectId/script-automations', {
    preHandler: app.authenticate, bodyLimit: 12 * 1024 * 1024,
    schema: { params: projectParams, body: scriptRegistrationRequestSchema.extend({ serviceToken: z.string().max(8192).optional() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const { serviceToken, ...registration } = request.body;
    managementProof(serviceToken, { projectId: request.params.projectId, automationId: scriptAutomationId(request.params.projectId, registration.registrationKey) }, 'upsert', registration);
    const row = await saveScriptAutomation(tx, request.userId, request.params.projectId, registration);
    const complete = await tx.automation.findUniqueOrThrow({ where: { id: row.id }, include: includes });
    return { automation: serializeScriptAutomation(complete) };
  })));

  // Read routes answer a missing project and an inaccessible one with the same NOT_FOUND, like the legacy automation
  // routes: no project-id existence oracle, and web-ui heals a missing mirror on NOT_FOUND instead of reporting a denial.
  app.get('/v1/projects/:projectId/script-automations', {
    preHandler: app.authenticate, schema: { params: projectParams },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    if (!await projectAccess(tx, request.userId, request.params.projectId)) throw new Error('NOT_FOUND');
    const rows = await tx.automation.findMany({
      where: { projectId: request.params.projectId, payloadVersion: 3, deletedAt: null },
      include: includes, orderBy: { createdAt: 'desc' },
    });
    return { automations: rows.map(serializeScriptAutomation) };
  })));

  app.get('/v1/projects/:projectId/script-artifacts/:artifactId', {
    preHandler: app.authenticate,
    schema: { params: projectParams.extend({ artifactId: z.string().min(1).max(200) }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    if (!await projectAccess(tx, request.userId, request.params.projectId)) throw new Error('NOT_FOUND');
    const artifacts = createScriptArtifactService({ transaction: (action) => action({
      query: <T>(sql: string, values: unknown[] = []) => tx.$queryRawUnsafe<T[]>(sql, ...values),
    }) });
    return { artifact: await artifacts.get(request.params.projectId, request.params.artifactId) };
  })));

  app.post('/v1/projects/:projectId/script-automations/:automationId/runs', {
    preHandler: app.authenticate, bodyLimit: 70 * 1024,
    schema: { params: automationParams, body: scriptInvocationRequestSchema.extend({ serviceToken: z.string().max(8192).optional() }),
      headers: z.object({ 'idempotency-key': z.string().min(1).max(200) }) },
  }, (request, reply) => handle(reply, async () => {
    const { serviceToken, ...input } = request.body;
    managementProof(serviceToken, request.params, 'run', { ...input, idempotencyKey: request.headers['idempotency-key'] });
    const run = await dependencies.transaction((tx) => enqueueScriptInput(tx, request.userId, request.params.projectId,
      request.params.automationId, input, request.headers['idempotency-key'], Date.now()));
    return reply.code(202).send({ runId: run.id, status: run.status });
  }));

  const serviceBody = z.strictObject({ serviceToken: z.string().min(1).max(8192) });
  app.post('/v1/projects/:projectId/script-automations/:automationId/key-sync', {
    preHandler: app.authenticate, schema: { params: automationParams, body: serviceBody },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const claims = proof(request.body.serviceToken, 'key-sync', request.params);
    if (!(await projectAccess(tx, request.userId, request.params.projectId))?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
    await scriptQueueInTransaction(tx).syncKey(claims, Date.now());
    return { ok: true };
  })));

  app.post('/v1/projects/:projectId/script-automations/:automationId/external-runs', {
    preHandler: app.authenticate, bodyLimit: 80 * 1024,
    schema: { params: automationParams, body: serviceBody.extend(scriptInvocationRequestSchema.shape) },
  }, (request, reply) => handle(reply, async () => {
    const claims = proof(request.body.serviceToken, 'enqueue', request.params);
    const run = await dependencies.transaction((tx) => enqueueScriptApiInput(tx, request.userId, claims, { input: request.body.input }, Date.now()));
    return reply.code(202).send({ runId: run.id, status: run.status });
  }));

  app.post('/v1/projects/:projectId/script-automations/:automationId/external-runs/:runId/status', {
    preHandler: app.authenticate, schema: { params: automationParams.extend({ runId: identifier }), body: serviceBody },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const claims = proof(request.body.serviceToken, 'status', request.params);
    if (claims.runId !== request.params.runId) throw new Error('SCRIPT_SERVICE_PROOF_INVALID');
    if (!await projectAccess(tx, request.userId, request.params.projectId)) throw new Error('NOT_FOUND');
    return scriptQueueInTransaction(tx).apiStatus(claims, Date.now());
  })));

  app.get('/v1/projects/:projectId/script-automations/:automationId/runs', {
    preHandler: app.authenticate, schema: { params: automationParams },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    if (!await projectAccess(tx, request.userId, request.params.projectId)) throw new Error('NOT_FOUND');
    const row = await tx.automation.findFirst({ where: { id: request.params.automationId, projectId: request.params.projectId, payloadVersion: 3, deletedAt: null } });
    if (!row) throw new Error('NOT_FOUND');
    const runs = await tx.scriptInvocation.findMany({ where: { automationId: row.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
    return { runs: runs.map(({ claimHash, inputCiphertext, logCiphertext, snapshot, ...run }) => ({ ...run,
      digest: (snapshot as { digest?: string }).digest ?? null, hasLog: logCiphertext !== null })) };
  })));

  app.get('/v1/projects/:projectId/script-automations/:automationId/runs/:runId/log', {
    preHandler: app.authenticate, schema: { params: automationParams.extend({ runId: identifier }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    if (!await projectAccess(tx, request.userId, request.params.projectId)) throw new Error('NOT_FOUND');
    const run = await tx.scriptInvocation.findFirst({ where: { id: request.params.runId, automationId: request.params.automationId,
      automation: { projectId: request.params.projectId, payloadVersion: 3, deletedAt: null } }, select: { logCiphertext: true } });
    if (!run) throw new Error('NOT_FOUND');
    return run;
  })));

  app.post('/v1/projects/:projectId/script-automations/:automationId/runs/:runId/cancel', {
    preHandler: app.authenticate, schema: { params: automationParams.extend({ runId: identifier }), body: z.strictObject({ serviceToken: z.string().max(8192).optional() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    if (!(await projectAccess(tx, request.userId, request.params.projectId))?.canEdit) throw new Error('PROJECT_WRITE_DENIED');
    managementProof(request.body.serviceToken, request.params, 'cancel', { runId: request.params.runId });
    await scriptQueueInTransaction(tx).cancel(request.params.projectId, request.params.automationId, request.params.runId, Date.now());
    return { ok: true };
  })));

  app.get('/v1/machines/:machineId/script-automations', {
    preHandler: app.authenticate, schema: { params: machineParams, querystring: z.strictObject({ after: identifier.optional() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const rows = await tx.automation.findMany({ where: { machineAccountId: request.userId, machineId: request.params.machineId,
      payloadVersion: 3, deletedAt: null, ...(request.query.after ? { id: { gt: request.query.after } } : {}) },
      include: includes, orderBy: { id: 'asc' }, take: 100 });
    return { automations: rows.map((row) => {
      const { encrypted: _encrypted, admission: _admission, ...metadata } = serializeScriptAutomation(row);
      return metadata;
    }), nextCursor: rows.length === 100 ? rows[99].id : null };
  })));

  app.get('/v1/machines/:machineId/script-automations/:automationId/artifact', {
    preHandler: app.authenticate, schema: { params: machineAutomationParams },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const { row } = await validateScriptTarget(tx, request.params.automationId, request.userId, request.params.machineId);
    const revision = await tx.scriptAutomationRevision.findUniqueOrThrow({ where: {
      automationId_revision: { automationId: row.id, revision: row.revision },
    } });
    return {
      encrypted: scriptEncryptedValueSchema.parse(JSON.parse(revision.payloadCiphertext)),
      admission: scriptAdmissionSchema.parse(revision.admission),
      artifact: await tx.scriptArtifact.findUniqueOrThrow({ where: { id: revision.artifactId } }),
    };
  })));

  app.post('/v1/machines/:machineId/script-automations/:automationId/ready', {
    preHandler: app.authenticate, schema: { params: machineAutomationParams, body: z.strictObject({ revision: z.number().int().positive() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    await markScriptReady(tx, request.userId, request.params.machineId, request.params.automationId, request.body.revision, Date.now());
    return { ok: true };
  })));

  app.post('/v1/machines/:machineId/script-automations/:automationId/validation-failed', {
    preHandler: app.authenticate, schema: { params: machineAutomationParams, body: z.strictObject({ revision: z.number().int().positive() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    await markScriptValidationFailed(tx, request.userId, request.params.machineId, request.params.automationId, request.body.revision);
    return { ok: true };
  })));

  app.post('/v1/machines/:machineId/script-automations/:automationId/claim', {
    preHandler: app.authenticate, schema: { params: machineAutomationParams, body: z.strictObject({}) },
  }, (request, reply) => handle(reply, async () => {
    const existing = await dependencies.transaction(async (tx) => {
      await validateScriptTarget(tx, request.params.automationId, request.userId, request.params.machineId);
      const claim = await scriptQueueInTransaction(tx).claim(request.params.automationId, request.userId, request.params.machineId, Date.now());
      const artifact = claim ? await tx.scriptArtifact.findUniqueOrThrow({ where: { id: claim.run.snapshot.artifactId } }) : null;
      return { claim, artifact };
    });
    if (existing.claim) {
      try {
        await dependencies.transaction((tx) => enqueueDueScript(tx, request.userId, request.params.machineId, request.params.automationId, Date.now()));
      } catch (error) {
      app.log.warn({ err: error, automationId: request.params.automationId }, 'Deferred due script admission after returning an existing claim');
      }
      return existing;
    }
    return dependencies.transaction(async (tx) => {
      await enqueueDueScript(tx, request.userId, request.params.machineId, request.params.automationId, Date.now());
      const queued = await scriptQueueInTransaction(tx).claim(request.params.automationId, request.userId, request.params.machineId, Date.now());
      const artifact = queued ? await tx.scriptArtifact.findUniqueOrThrow({ where: { id: queued.run.snapshot.artifactId } }) : null;
      return { claim: queued, artifact };
    });
  }));

  async function ownedRun(tx: Prisma.TransactionClient, accountId: string, machineId: string, id: string) {
    const run = await tx.scriptInvocation.findUnique({ where: { id } });
    if (!run) throw new Error('NOT_FOUND');
    const snapshot = run.snapshot as { machineId?: string; machineAccountId?: string };
    if (snapshot.machineId !== machineId || snapshot.machineAccountId !== accountId) throw new Error('MACHINE_DENIED');
    return run;
  }
  app.post('/v1/machines/:machineId/script-runs/:runId/context', {
    preHandler: app.authenticate, schema: { params: runParams, body: claimBody },
  }, (request, reply) => handle(reply, async () => {
    const outcome = await dependencies.transaction(async (tx) => {
      const run = await ownedRun(tx, request.userId, request.params.machineId, request.params.runId);
      const { row } = await validateScriptTarget(tx, run.automationId, request.userId, request.params.machineId);
      try {
        const context = await scriptQueueInTransaction(tx).context(run.id, request.body.token, Date.now());
        return { ok: true as const, value: { ...context, projectId: row.projectId, runId: run.id, machineId: request.params.machineId, machineAccountId: request.userId } };
      } catch (error) {
        if (error instanceof Error && error.message === 'CLAIM_INVALID') return { ok: false as const };
        throw error;
      }
    });
    if (!outcome.ok) throw new Error('CLAIM_INVALID');
    return outcome.value;
  }));
  for (const operation of ['start', 'heartbeat', 'abandon'] as const) {
    app.post(`/v1/machines/:machineId/script-runs/:runId/${operation}`, {
      preHandler: app.authenticate, schema: { params: runParams, body: claimBody.extend({ executionProof: z.string().max(8192).optional() }) },
    }, (request, reply) => handle(reply, async () => {
      const ok = await dependencies.transaction(async (tx) => {
        const run = await ownedRun(tx, request.userId, request.params.machineId, request.params.runId);
        if (operation === 'start') {
          const { row } = await validateScriptTarget(tx, run.automationId, request.userId, request.params.machineId);
          if (dependencies.serviceSecret?.()) {
            const claims = proof(request.body.executionProof ?? '', 'execution', { projectId: row.projectId, automationId: run.automationId });
            if (claims.runId !== run.id || claims.machineId !== request.params.machineId
              || claims.machineAccountId !== request.userId || claims.generation !== run.generation) throw new Error('SCRIPT_SERVICE_PROOF_INVALID');
          }
        }
        try { await scriptQueueInTransaction(tx)[operation](run.id, request.body.token, Date.now()); }
        catch (error) {
          if (error instanceof Error && error.message === 'CLAIM_INVALID') return false;
          throw error;
        }
        return true;
      });
      if (!ok) throw new Error('CLAIM_INVALID');
      return { ok: true };
    }));
  }
  app.post('/v1/machines/:machineId/script-runs/:runId/complete', {
    preHandler: app.authenticate, bodyLimit: 6 * 1024 * 1024,
    schema: { params: runParams, body: claimBody.extend({ exitCode: z.number().int().nullable(),
      logCiphertext: z.string().max(6 * 1024 * 1024).refine((value) => {
        try { return scriptEncryptedValueSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
      }), failureCode: z.string().regex(/^[A-Z0-9_]{1,100}$/).optional() }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const run = await ownedRun(tx, request.userId, request.params.machineId, request.params.runId);
    const receipt = await scriptQueueInTransaction(tx).complete(run.id, request.body.token, request.body, Date.now());
    return { ok: true, ...receipt };
  })));
  app.post('/v1/machines/:machineId/script-runs/:runId/fail', {
    preHandler: app.authenticate,
    schema: { params: runParams, body: claimBody.extend({ failureCode: z.string().regex(/^[A-Z0-9_]{1,100}$/) }) },
  }, (request, reply) => handle(reply, async () => dependencies.transaction(async (tx) => {
    const run = await ownedRun(tx, request.userId, request.params.machineId, request.params.runId);
    await scriptQueueInTransaction(tx).failClaim(run.id, request.body.token, request.body.failureCode, Date.now());
    return { ok: true };
  })));
}

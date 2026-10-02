import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import { decryptScriptValue, encryptScriptValue, openScriptValueForMachine, scriptAdmissionSchema, scriptAutomationPayloadSchema,
  scriptEncryptedValueSchema } from '@slopus/happy-wire';
import { runManagedScript, type ManagedScriptInput, type ManagedScriptResult } from './managedScriptRunner';
import { judgePayload, type PayloadTrust } from './payloadTrust';

const artifactSchema = z.object({ id: z.string(), projectId: z.string(), digest: z.string(), encrypted: scriptEncryptedValueSchema });
const recordSchema = z.object({ id: z.string(), projectId: z.string(), registrationKey: z.string(), revision: z.number().int(),
  generation: z.number().int(), ready: z.boolean(), machineId: z.string(), machineAccountId: z.string(),
  machinePublicKey: z.string(), viewerPublicKey: z.string() });
const snapshotSchema = z.object({ artifactId: z.string(), digest: z.string(), payloadCiphertext: z.string(),
  admission: scriptAdmissionSchema, projectId: z.string(), registrationKey: z.string(), machineId: z.string(), machineAccountId: z.string() });
const claimSchema = z.object({ token: z.string(), run: z.object({ id: z.string().regex(/^[\w-]+$/), automationId: z.string(),
  revision: z.number().int(), generation: z.number().int(), inputCiphertext: z.string(), snapshot: snapshotSchema }) });
const journalSchema = z.object({ runId: z.string().regex(/^[\w-]+$/), token: z.string(),
  operation: z.enum(['fail', 'abandon', 'complete']), body: z.record(z.string(), z.unknown()) });
type Record = z.infer<typeof recordSchema>;
type Journal = z.infer<typeof journalSchema>;
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;
const SCRIPT_VALUE_LIMIT = 4 * 1024 * 1024;

export class ScriptRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function boundedLogValue(result: ManagedScriptResult, context: { projectId: string; resourceId: string; purpose: 'log' }) {
  const value = (end: number) => ({ log: result.log.slice(0, end), truncated: result.truncated || end < result.log.length });
  const fits = (end: number) => Buffer.byteLength(JSON.stringify({ context, value: value(end) })) <= SCRIPT_VALUE_LIMIT;
  if (fits(result.log.length)) return value(result.log.length);
  let low = 0;
  let high = result.log.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return value(low);
}

export function createScriptAutomationWorker(options: {
  machineId: string; accountId: string; machineSecretKey: Uint8Array; image: string; directory: string;
  /** Whose settings and code this worker runs (aplus-dev-studio specs/e2ee-machine-control-boundary R13/R14). */
  trust: PayloadTrust; onUnauthenticated?: (what: string) => void;
  request: Request; recoverContainers: () => Promise<void>; log: (message: string) => void;
  execute?: (input: ManagedScriptInput) => Promise<ManagedScriptResult>;
  authorizeStart?: (record: Record, runId: string, token: string) => Promise<string>;
  resolveSecrets?: (record: Record, refs: { [name: string]: string }, runId: string, token: string) => Promise<{ secrets: { [name: string]: string }; approvedPrivateOrigins: string[] }>;
}) {
  let stopped = false;
  let ticking: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  const prefix = `/v1/machines/${encodeURIComponent(options.machineId)}`;
  const file = (id: string) => join(options.directory, `${id}.json`);
  const post = (path: string, body: unknown) => options.request('POST', prefix + path, body);
  async function writeJournal(journal: Journal) {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${file(journal.runId)}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file(journal.runId));
    const directory = await open(options.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async function deliver(journal: Journal) {
    let response: unknown;
    try {
      response = await post(`/script-runs/${encodeURIComponent(journal.runId)}/${journal.operation}`, { ...journal.body, token: journal.token });
    } catch (error) {
      if (!(error instanceof ScriptRequestError) || error.status !== 404 || error.code !== 'NOT_FOUND') throw error;
      options.log(`Script run was deleted before its report could be recorded: ${journal.runId}`);
      await rm(file(journal.runId));
      return;
    }
    if (journal.operation === 'complete') {
      const receipt = z.object({ recorded: z.boolean().optional(), status: z.string().optional() }).parse(response);
      if (receipt.recorded === false) {
        if (!['UNKNOWN', 'EXPIRED'].includes(receipt.status ?? '')) throw new Error('SCRIPT_REPORT_RECEIPT_INVALID');
        options.log(`Late script report was not recorded: ${journal.runId} (${receipt.status})`);
      }
    }
    await rm(file(journal.runId));
  }
  async function recover() {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    // A previous daemon may have disappeared while its Docker containers lived.
    // Never release that server slot until container cleanup has succeeded.
    await options.recoverContainers();
    for (const name of (await readdir(options.directory)).sort()) {
      if (!name.endsWith('.json')) continue;
      const journal = journalSchema.parse(JSON.parse(await readFile(join(options.directory, name), 'utf8')));
      if (name !== `${journal.runId}.json`) throw new Error('SCRIPT_JOURNAL_INVALID');
      await deliver(journal);
    }
  }
  /**
   * A setting or artifact only from a sender this daemon trusts: the customer
   * key, or its own automation key for scripts the agent tool registered.
   * Anonymous values run only in compat. Throws the refusal code.
   */
  function openTrusted(encrypted: unknown, context: { projectId: string; resourceId: string; purpose: 'configuration' | 'artifact' }): unknown {
    const verdict = judgePayload({ trust: options.trust, allowMachineSender: true,
      opening: openScriptValueForMachine({ encrypted: scriptEncryptedValueSchema.parse(encrypted), context, secretKey: options.machineSecretKey }) });
    if (!verdict.run) throw new Error(verdict.code === 'PAYLOAD_UNREADABLE' ? 'SCRIPT_DECRYPT_FAILED' : verdict.code);
    if (!verdict.authenticated) options.onUnauthenticated?.(`script ${context.purpose} ${context.resourceId}`);
    return verdict.payload;
  }
  function verify(record: Record, encrypted: unknown, artifact: z.infer<typeof artifactSchema>, admission: z.infer<typeof scriptAdmissionSchema>) {
    const payload = scriptAutomationPayloadSchema.parse(openTrusted(encrypted,
      { projectId: record.projectId, resourceId: record.registrationKey, purpose: 'configuration' }));
    const expected = { artifactId: payload.action.artifactId, digest: payload.action.digest,
      schedule: payload.schedule, externalEnabled: payload.externalEnabled, inputSchema: payload.inputSchema };
    if (!isDeepStrictEqual(expected, admission) || artifact.id !== admission.artifactId || artifact.projectId !== record.projectId
      || artifact.digest !== admission.digest) throw new Error('SCRIPT_ADMISSION_MISMATCH');
    const { source } = z.strictObject({ source: z.string() }).parse(openTrusted(artifact.encrypted,
      { projectId: record.projectId, resourceId: artifact.id, purpose: 'artifact' }));
    if (createHash('sha256').update(source).digest('hex') !== admission.digest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
    return { payload, source };
  }
  async function executeClaim(record: Record, claim: z.infer<typeof claimSchema>, artifact: z.infer<typeof artifactSchema>) {
    const { run, token } = claim;
    let journal: Journal = { runId: run.id, token, operation: 'fail', body: { failureCode: 'WORKER_RESTARTED_BEFORE_START' } };
    await writeJournal(journal);
    const controller = new AbortController();
    activeController = controller;
    if (stopped) controller.abort();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let beating = false;
    let result: ManagedScriptResult;
    try {
      if (run.automationId !== record.id || run.generation !== record.generation || run.snapshot.projectId !== record.projectId
        || run.snapshot.registrationKey !== record.registrationKey || run.snapshot.machineId !== options.machineId
        || run.snapshot.machineAccountId !== options.accountId) throw new Error('SCRIPT_CLAIM_MISMATCH');
      const { payload, source } = verify(record, JSON.parse(run.snapshot.payloadCiphertext), artifact, run.snapshot.admission);
      const input = z.record(z.string(), z.json()).parse(decryptScriptValue({ encrypted: JSON.parse(run.inputCiphertext),
        context: { projectId: record.projectId, resourceId: run.id, purpose: 'input' }, recipient: 'machine', secretKey: options.machineSecretKey }));
      let binding: { secrets: { [name: string]: string }; approvedPrivateOrigins: string[] } = { secrets: {}, approvedPrivateOrigins: [] };
      if (Object.keys(payload.action.secretRefs).length) {
        if (!options.resolveSecrets) throw new Error('SCRIPT_SECRET_RESOLVER_UNAVAILABLE');
        binding = await options.resolveSecrets(record, payload.action.secretRefs, run.id, token);
      }
      result = await (options.execute ?? runManagedScript)({ runId: run.id, source, action: payload.action, input,
        ...binding, image: options.image, signal: controller.signal,
        beforeStart: async () => {
          controller.signal.throwIfAborted();
          const executionProof = await options.authorizeStart?.(record, run.id, token);
          controller.signal.throwIfAborted();
          // Persist ambiguity before sending start: a lost response may still mean it started.
          journal = { runId: run.id, token, operation: 'abandon', body: {} };
          await writeJournal(journal);
          await post(`/script-runs/${encodeURIComponent(run.id)}/start`, { token, ...(executionProof ? { executionProof } : {}) });
          heartbeat = setInterval(() => {
            if (beating) return;
            beating = true;
            void post(`/script-runs/${encodeURIComponent(run.id)}/heartbeat`, { token })
              .catch(() => controller.abort()).finally(() => { beating = false; });
          }, 30000);
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCRIPT_CONTAINER_CLEANUP_FAILED') throw error;
      const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'SCRIPT_PREPARATION_FAILED';
      if (journal.operation === 'fail') journal.body = { failureCode: code };
      await writeJournal(journal);
      await deliver(journal);
      return;
    } finally { if (heartbeat) clearInterval(heartbeat); }
    const logContext = { projectId: record.projectId, resourceId: run.id, purpose: 'log' as const };
    const encrypted = encryptScriptValue({ value: boundedLogValue(result, logContext),
      context: logContext,
      viewerPublicKey: new Uint8Array(Buffer.from(record.viewerPublicKey, 'base64')),
      machinePublicKey: new Uint8Array(Buffer.from(record.machinePublicKey, 'base64')) });
    journal = { runId: run.id, token, operation: 'complete', body: { exitCode: result.exitCode,
      logCiphertext: JSON.stringify(encrypted), ...(result.failureCode ? { failureCode: result.failureCode } : {}) } };
    await writeJournal(journal);
    await deliver(journal);
  }
  return {
    recover,
    async stop() {
      stopped = true;
      activeController?.abort();
      if (ticking) await ticking;
    },
    async tick() {
      if (stopped) return;
      if (ticking) return ticking;
      ticking = (async () => {
        await recover();
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page = z.object({ automations: z.array(recordSchema), nextCursor: z.string().nullable() }).parse(
            await options.request('GET', `${prefix}/script-automations${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`));
          for (const record of page.automations) {
            if (stopped) return;
            if (record.machineId !== options.machineId || record.machineAccountId !== options.accountId) throw new Error('MACHINE_DENIED');
            if (!record.ready) {
              const revision = z.object({ encrypted: scriptEncryptedValueSchema, admission: scriptAdmissionSchema,
                artifact: artifactSchema }).parse(await options.request('GET',
                `${prefix}/script-automations/${encodeURIComponent(record.id)}/artifact`));
              try {
                verify(record, revision.encrypted, revision.artifact, revision.admission);
              } catch (error) {
                const reason = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'SCRIPT_REVISION_INVALID';
                options.log(`Script revision validation failed: ${record.id}@${record.revision} (${reason})`);
                try { await post(`/script-automations/${encodeURIComponent(record.id)}/validation-failed`, { revision: record.revision }); }
                catch (error) {
                  if (!(error instanceof ScriptRequestError) || ![403, 404, 409].includes(error.status)) throw error;
                  options.log(`Script validation report unavailable: ${record.id} (${error.code})`);
                }
                continue;
              }
              try { await post(`/script-automations/${encodeURIComponent(record.id)}/ready`, { revision: record.revision }); }
              catch (error) {
                if (!(error instanceof ScriptRequestError) || ![403, 404, 409].includes(error.status)) throw error;
                options.log(`Script revision unavailable: ${record.id} (${error.code})`);
                continue;
              }
            }
            let raw: unknown;
            try { raw = await post(`/script-automations/${encodeURIComponent(record.id)}/claim`, {}); }
            catch (error) {
              if (!(error instanceof ScriptRequestError) || ![403, 404, 409, 429].includes(error.status)) throw error;
              options.log(`Script claim unavailable: ${record.id} (${error.code})`);
              continue;
            }
            const response = z.object({ claim: claimSchema.nullable(), artifact: artifactSchema.nullable() }).parse(raw);
            if (response.claim) {
              if (!response.artifact) throw new Error('SCRIPT_ARTIFACT_MISSING');
              await executeClaim(record, response.claim, response.artifact);
            }
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('SCRIPT_POLL_CURSOR_REPEATED');
          if (cursor) seen.add(cursor);
        } while (cursor);
      })();
      try { await ticking; } finally { ticking = null; activeController = null; }
    },
  };
}

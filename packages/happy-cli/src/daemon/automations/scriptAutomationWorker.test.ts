import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { decryptScriptValue, encryptScriptValue, type ScriptAutomationPayload } from '@slopus/happy-wire';
import { createScriptAutomationWorker, ScriptRequestError } from './scriptAutomationWorker';
import type { ManagedScriptInput, ManagedScriptResult } from './managedScriptRunner';
import type { PayloadTrust } from './payloadTrust';

let directory: string;
const pair = nacl.box.keyPair();
const company = nacl.box.keyPair();
const trust = (mode: 'compat' | 'strict'): PayloadTrust => ({ mode, customerPublicKey: company.publicKey, machineAutomationPublicKey: pair.publicKey });
const source = 'console.log("collected")';
const payload: ScriptAutomationPayload = { version: 3, name: 'Collect', schedule: null, externalEnabled: false, inputSchema: {},
  action: { kind: 'script', runtime: 'node', artifactId: 'artifact', digest: createHash('sha256').update(source).digest('hex'),
    entrypoint: 'collect.mjs', args: [], timeoutSeconds: 10, secretRefs: {}, allowedOrigins: [] } };
const seal = (value: unknown, resourceId: string, purpose: 'input' | 'configuration' | 'artifact') => encryptScriptValue({ value,
  context: { projectId: 'project', resourceId, purpose }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey });
const admission = { artifactId: payload.action.artifactId, digest: payload.action.digest, schedule: null, externalEnabled: false, inputSchema: {} };
const record = { id: 'automation', projectId: 'project', registrationKey: 'collect', revision: 1, generation: 1, ready: false,
  machineId: 'machine', machineAccountId: 'account', machineKeyVersion: 1, viewerKeyVersion: 1,
  viewerPublicKey: Buffer.from(pair.publicKey).toString('base64'), machinePublicKey: Buffer.from(pair.publicKey).toString('base64'),
  encrypted: seal(payload, 'collect', 'configuration'), admission,
  artifact: { id: 'artifact', projectId: 'project', digest: payload.action.digest, encrypted: seal({ source }, 'artifact', 'artifact') } };
const { encrypted: _encrypted, admission: _admission, artifact: _artifact, ...metadata } = record;
const revision = (selectedAdmission = admission) => ({ encrypted: record.encrypted, admission: selectedAdmission, artifact: record.artifact });
const claim = { token: 'token', run: { id: 'run', automationId: 'automation', revision: 1, generation: 1,
  inputCiphertext: JSON.stringify(seal({ count: 2 }, 'run', 'input')),
  snapshot: { ...admission, admission, payloadCiphertext: JSON.stringify(record.encrypted), projectId: 'project', registrationKey: 'collect', machineId: 'machine', machineAccountId: 'account' } } };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'script-worker-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function setup(options: Partial<Parameters<typeof createScriptAutomationWorker>[0]> = {}) {
  let claimed = false;
  const request = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => {
    if (method === 'GET' && path.endsWith('/artifact')) return revision();
    if (method === 'GET') return { automations: [metadata], nextCursor: null };
    if (path.endsWith('/claim')) {
      if (claimed) return { claim: null, artifact: null };
      claimed = true; return { claim, artifact: record.artifact };
    }
    return { ok: true };
  });
  const execute = vi.fn(async (input: ManagedScriptInput): Promise<ManagedScriptResult> => {
    await input.beforeStart?.();
    return { exitCode: 0, failureCode: null, log: 'collected', truncated: false };
  });
  const recoverContainers = vi.fn(async () => {});
  const log = vi.fn();
  const worker = createScriptAutomationWorker({ machineId: 'machine', accountId: 'account', machineSecretKey: pair.secretKey,
    trust: trust('compat'), image: 'sha256:' + 'a'.repeat(64), directory, request, execute, recoverContainers, log, ...options });
  return { worker, request, execute, recoverContainers, log };
}
it('verifies encrypted code, starts the claimed snapshot and reports encrypted logs without creating an agent', async () => {
  const { worker, request, execute } = setup();
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0]).toMatchObject({ source, input: { count: 2 }, secrets: {}, action: payload.action });
  const paths = request.mock.calls.map((call) => call[1]);
  expect(paths.findIndex((path) => path.endsWith('/artifact'))).toBeLessThan(paths.findIndex((path) => path.endsWith('/ready')));
  expect(paths.findIndex((path) => path.endsWith('/ready'))).toBeLessThan(paths.findIndex((path) => path.endsWith('/claim')));
  expect(paths.findIndex((path) => path.endsWith('/start'))).toBeLessThan(paths.findIndex((path) => path.endsWith('/complete')));
  const report = request.mock.calls.find((call) => call[1].endsWith('/complete'))![2] as { logCiphertext: string };
  expect(decryptScriptValue({ encrypted: JSON.parse(report.logCiphertext), context: { projectId: 'project', resourceId: 'run', purpose: 'log' }, recipient: 'viewer', secretKey: pair.secretKey })).toEqual({ log: 'collected', truncated: false });
  expect(await readdir(directory)).toEqual([]);
});
it('truncates JSON-expanding control-character logs and preserves the successful exit result', async () => {
  const { worker, request, execute } = setup();
  execute.mockImplementation(async (input) => {
    await input.beforeStart?.();
    return { exitCode: 0, failureCode: null, log: '\0'.repeat(1024 * 1024), truncated: false };
  });
  await worker.tick();
  const report = request.mock.calls.find((call) => call[1].endsWith('/complete'))?.[2] as { exitCode: number; logCiphertext: string };
  expect(report.exitCode).toBe(0);
  const value = decryptScriptValue({ encrypted: JSON.parse(report.logCiphertext), context: { projectId: 'project', resourceId: 'run', purpose: 'log' }, recipient: 'viewer', secretKey: pair.secretKey }) as { log: string; truncated: boolean };
  expect(value.truncated).toBe(true);
  expect(value.log.length).toBeLessThan(1024 * 1024);
  expect(request.mock.calls.some((call) => call[1].endsWith('/abandon'))).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});
it('aborts and drains active script execution before shutdown finishes', async () => {
  const { worker, execute, request } = setup();
  execute.mockImplementation(async (input) => {
    await input.beforeStart?.();
    await new Promise<void>((resolve) => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { exitCode: 137, failureCode: 'SCRIPT_CANCELLED', log: '', truncated: false };
  });
  const running = worker.tick();
  await vi.waitFor(() => expect(request.mock.calls.some((call) => call[1].endsWith('/start'))).toBe(true));
  await worker.stop();
  await running;
  expect(request.mock.calls.find((call) => call[1].endsWith('/complete'))?.[2]).toMatchObject({ failureCode: 'SCRIPT_CANCELLED' });
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
});
it('retains a terminal outbox on report failure and retries it without executing again', async () => {
  const { worker, request, execute } = setup();
  const original = request.getMockImplementation()!;
  let fail = true;
  request.mockImplementation(async (method, path, body) => {
    if (path.endsWith('/complete') && fail) throw new Error('offline');
    return original(method, path, body);
  });
  await expect(worker.tick()).rejects.toThrow('offline');
  expect((await readdir(directory)).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  fail = false;
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
  expect(request.mock.calls.filter((call) => call[1].endsWith('/complete'))).toHaveLength(2);
  expect(await readdir(directory)).toEqual([]);
});
it('never executes an artifact whose digest differs from the accepted snapshot', async () => {
  const { worker, request, execute } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, path, body) => {
    const response = await original(method, path, body);
    if (path.endsWith('/claim')) return { claim, artifact: { ...record.artifact, encrypted: seal({ source: 'changed' }, 'artifact', 'artifact') } };
    return response;
  });
  await worker.tick();
  expect(execute).not.toHaveBeenCalled();
  expect(request.mock.calls.find((call) => call[1].endsWith('/fail'))?.[2]).toMatchObject({ failureCode: 'ARTIFACT_DIGEST_MISMATCH' });
});
it('clears a late report only after an explicit terminal receipt and logs the discarded result', async () => {
  const { worker, request, log } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, path, body) => path.endsWith('/complete')
    ? { ok: true, recorded: false, status: 'UNKNOWN' } : original(method, path, body));
  await worker.tick();
  expect(log).toHaveBeenCalledWith('Late script report was not recorded: run (UNKNOWN)');
  expect(await readdir(directory)).toEqual([]);
});
it('clears a deleted run receipt but retains the outbox on authentication failure', async () => {
  const { worker, request, log } = setup();
  const original = request.getMockImplementation()!;
  let status = 401;
  request.mockImplementation(async (method, path, body) => {
    if (path.endsWith('/complete')) throw new ScriptRequestError(status, status === 404 ? 'NOT_FOUND' : 'UNAUTHORIZED');
    return original(method, path, body);
  });
  await expect(worker.tick()).rejects.toThrow('UNAUTHORIZED');
  expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  status = 404;
  await worker.tick();
  expect(log).toHaveBeenCalledWith('Script run was deleted before its report could be recorded: run');
  expect(await readdir(directory)).toEqual([]);
});
it('keeps the execution slot and outbox when owned container recovery fails', async () => {
  const { worker, recoverContainers, request, execute } = setup();
  recoverContainers.mockRejectedValueOnce(new Error('Docker unavailable'));
  await expect(worker.tick()).rejects.toThrow('Docker unavailable');
  expect(request).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it('continues other automations when one record needs a new key binding', async () => {
  const { worker, request, execute, log } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path.endsWith('/artifact')) return original(method, path, body);
    if (method === 'GET') return { automations: [{ ...metadata, id: 'stale' }, metadata], nextCursor: null };
    if (path.includes('/stale/')) throw new ScriptRequestError(409, 'KEY_VERSION_CONFLICT');
    return original(method, path, body);
  });
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('Script revision unavailable: stale (KEY_VERSION_CONFLICT)');
});

it('reauthorizes immediately before start and never starts code after permission denial', async () => {
  const authorizeStart = vi.fn(async () => { throw new Error('PROJECT_WRITE_DENIED'); });
  const { worker, execute, request } = setup({ authorizeStart });
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
  expect(authorizeStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'automation', projectId: 'project', machineId: 'machine' }), 'run', 'token');
  expect(request.mock.calls.some((call) => call[1].endsWith('/start'))).toBe(false);
  expect(request.mock.calls.find((call) => call[1].endsWith('/fail'))?.[2]).toMatchObject({ failureCode: 'PROJECT_WRITE_DENIED' });
});
it('sends the Studio proof with the start claim for scripts without secrets', async () => {
  const authorizeStart = vi.fn(async () => 'signed-proof');
  const { worker, request } = setup({ authorizeStart });
  await worker.tick();
  expect(authorizeStart).toHaveBeenCalledOnce();
  expect(request.mock.calls.find((call) => call[1].endsWith('/start'))?.[2]).toEqual({ token: 'token', executionProof: 'signed-proof' });
});
it('reports a rejected encrypted revision and never claims or executes its code', async () => {
  const request = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' && path.endsWith('/artifact')
    ? revision({ ...admission, digest: '0'.repeat(64) })
    : method === 'GET' ? { automations: [metadata], nextCursor: null } : { ok: true });
  const { worker, execute } = setup({ request });
  await worker.tick();
  expect(request).toHaveBeenCalledWith('POST', '/v1/machines/machine/script-automations/automation/validation-failed', { revision: 1 });
  expect(execute).not.toHaveBeenCalled();
  expect(request.mock.calls.some((call) => String(call[1]).endsWith('/claim'))).toBe(false);
});

it.each([403, 404, 409])('continues healthy automations when a validation failure report becomes unavailable (%s)', async (status) => {
  const { worker, request, execute, log } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path.endsWith('/stale/artifact')) return revision({ ...admission, digest: '0'.repeat(64) });
    if (method === 'GET' && path.endsWith('/artifact')) return original(method, path, body);
    if (method === 'GET') return { automations: [{ ...metadata, id: 'stale' }, metadata], nextCursor: null };
    if (path === '/v1/machines/machine/script-automations/stale/validation-failed') throw new ScriptRequestError(status, 'REVISION_UNAVAILABLE');
    return original(method, path, body);
  });
  await worker.tick();
  expect(request).toHaveBeenCalledWith('POST', '/v1/machines/machine/script-automations/stale/validation-failed', { revision: 1 });
  expect(execute).toHaveBeenCalledOnce();
  expect(request.mock.calls.some((call) => call[1] === '/v1/machines/machine/script-automations/stale/claim')).toBe(false);
  expect(request.mock.calls.some((call) => call[1].endsWith('/complete'))).toBe(true);
  expect(log).toHaveBeenCalledWith('Script validation report unavailable: stale (REVISION_UNAVAILABLE)');
});
it('surfaces transient validation-report failures instead of silently discarding them', async () => {
  const { worker, request, execute } = setup();
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path.endsWith('/artifact')) return revision({ ...admission, digest: '0'.repeat(64) });
    if (method === 'GET') return { automations: [metadata], nextCursor: null };
    throw new ScriptRequestError(503, 'SCRIPT_STORAGE_UNAVAILABLE');
  });
  await expect(worker.tick()).rejects.toThrow('SCRIPT_STORAGE_UNAVAILABLE');
  expect(execute).not.toHaveBeenCalled();
});

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13/R14 — whose code the
 * worker runs. The run input is sealed by the server itself and is checked
 * against the signed input schema instead (R16).
 */
function sealedBy(sender?: nacl.BoxKeyPair) {
  const sealWith = (value: unknown, resourceId: string, purpose: 'configuration' | 'artifact') => encryptScriptValue({ value,
    context: { projectId: 'project', resourceId, purpose }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey,
    ...(sender ? { sender } : {}) });
  const encrypted = sealWith(payload, 'collect', 'configuration');
  const artifact = { ...record.artifact, encrypted: sealWith({ source }, 'artifact', 'artifact') };
  const runClaim = { ...claim, run: { ...claim.run, snapshot: { ...claim.run.snapshot, payloadCiphertext: JSON.stringify(encrypted) } } };
  let claimed = false;
  return vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => {
    if (method === 'GET' && path.endsWith('/artifact')) return { encrypted, admission, artifact };
    if (method === 'GET') return { automations: [metadata], nextCursor: null };
    if (path.endsWith('/claim')) {
      if (claimed) return { claim: null, artifact: null };
      claimed = true; return { claim: runClaim, artifact };
    }
    return { ok: true };
  });
}

it('runs code the customer key sealed under strict machine control', async () => {
  const { worker, execute } = setup({ request: sealedBy(company), trust: trust('strict') });
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
});

it('runs code the agent tool sealed with this machine\'s own automation key', async () => {
  const { worker, execute } = setup({ request: sealedBy(pair), trust: trust('strict') });
  await worker.tick();
  expect(execute).toHaveBeenCalledOnce();
});

it('refuses anonymously sealed code under strict machine control and never claims it', async () => {
  const request = sealedBy();
  const { worker, execute, log } = setup({ request, trust: trust('strict') });
  await worker.tick();
  expect(request).toHaveBeenCalledWith('POST', '/v1/machines/machine/script-automations/automation/validation-failed', { revision: 1 });
  expect(request.mock.calls.some((call) => String(call[1]).endsWith('/claim'))).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('Script revision validation failed: automation@1 (PAYLOAD_SENDER_ANONYMOUS)');
});

it('refuses code sealed by a sender it does not trust, even in compat', async () => {
  const request = sealedBy(nacl.box.keyPair());
  const { worker, execute, log } = setup({ request });
  await worker.tick();
  expect(execute).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('Script revision validation failed: automation@1 (PAYLOAD_SENDER_UNTRUSTED)');
});

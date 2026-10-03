import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { decryptScriptValue, encryptScriptValue, openScriptValueForMachine } from '@slopus/happy-wire';
import { createScriptAutomationTools } from './scriptAutomationTools';
let directory: string;
const pair = nacl.box.keyPair();
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'script-agent-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function setup(localAutomationKey?: nacl.BoxKeyPair) {
  const rows: any[] = [];
  const request = vi.fn(async (body: any): Promise<any> => {
    if (body.operation === 'target') return { machineId: 'machine', automationProtocolVersion: 5, machineKeyVersion: 1, viewerKeyVersion: 1,
      viewerPublicKey: Buffer.from(pair.publicKey).toString('base64'), machinePublicKey: Buffer.from(pair.publicKey).toString('base64') };
    if (body.operation === 'list') return { automations: rows };
    if (body.operation === 'upsert') {
      const r = body.registration;
      const row = { id: 'same-admin-id', projectId: 'project', revision: 1, generation: 1, ...r };
      rows.splice(0, rows.length, row);
      return { automation: row };
    }
    throw new Error('unexpected request');
  });
  const tools = createScriptAutomationTools({ projectId: 'project', directory, viewerKeyPair: pair, request,
    ...(localAutomationKey ? { localAutomationKey } : {}) });
  return { tools, request, rows };
}
it('encrypts the local bundle and preserves the same admin ID when the registration is retried', async () => {
  const source = 'console.log("collected")';
  await writeFile(join(directory, 'collect.mjs'), source);
  const { tools, request } = setup();
  const input = { operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null };
  expect(await tools.execute(input)).toMatchObject({ id: 'same-admin-id', revision: 1 });
  expect(await tools.execute(input)).toMatchObject({ id: 'same-admin-id', revision: 1 });
  const writes = request.mock.calls.filter(([body]) => body.operation === 'upsert');
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes)).not.toContain(source);
  const registration = writes[0][0].registration;
  expect(decryptScriptValue({ encrypted: registration.artifact, recipient: 'machine', secretKey: pair.secretKey,
    context: { projectId: 'project', resourceId: registration.admission.artifactId, purpose: 'artifact' } })).toEqual({ source });
  expect(await tools.execute({ operation: 'list' })).toMatchObject([{ id: 'same-admin-id', name: 'Collect' }]);
})
it('rejects files outside the project and a symlink escape before registering any code', async () => {
  const { tools, request } = setup();
  await symlink('/etc/hosts', join(directory, 'escape.mjs'));
  for (const sourcePath of ['/etc/hosts', '../outside.mjs', 'escape.mjs']) {
    await expect(tools.execute({ operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath, name: 'Collect', schedule: null })).rejects.toThrow();
  }
  expect(request.mock.calls.some(([body]) => body.operation === 'upsert')).toBe(false);
})
it('cannot silently overwrite an intervening revision', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const { tools, rows, request } = setup();
  const input = { operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null };
  await tools.execute(input);
  rows[0].revision = 3;
  await expect(tools.execute(input)).rejects.toThrow('REVISION_CONFLICT');
  expect(request.mock.calls.filter(([body]) => body.operation === 'upsert')).toHaveLength(1);
})

it('fetches encrypted logs only when one run is explicitly requested', async () => {
  const encrypted = encryptScriptValue({ value: { log: 'done', truncated: false },
    context: { projectId: 'project', resourceId: 'run-1', purpose: 'log' }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey });
  const request = vi.fn(async (body: any) => body.operation === 'runs' && body.runId
    ? { logCiphertext: JSON.stringify(encrypted) }
    : { runs: [{ id: 'run-1', status: 'COMPLETED', hasLog: true }] });
  const tools = createScriptAutomationTools({ projectId: 'project', directory, viewerKeyPair: pair, request });

  expect(await tools.execute({ operation: 'list_runs', automationId: 'automation' })).toEqual([{ id: 'run-1', status: 'COMPLETED', hasLog: true }]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await tools.execute({ operation: 'list_runs', automationId: 'automation', runId: 'run-1' })).toEqual([
    { id: 'run-1', status: 'COMPLETED', hasLog: true, log: { log: 'done', truncated: false } },
  ]);
  expect(request).toHaveBeenLastCalledWith({ operation: 'runs', automationId: 'automation', runId: 'run-1' });
})

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13 — the agent cannot sign as
 * the customer, but code it registers for its own machine is sealed by that machine's
 * automation key, which the daemon trusts for scripts.
 */
async function registered(localAutomationKey: nacl.BoxKeyPair) {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const { tools, request } = setup(localAutomationKey);
  await tools.execute({ operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null });
  const registration = request.mock.calls.find(([body]) => body.operation === 'upsert')![0].registration;
  const open = (encrypted: unknown, resourceId: string, purpose: 'configuration' | 'artifact') => openScriptValueForMachine({
    encrypted: encrypted as never, context: { projectId: 'project', resourceId, purpose }, secretKey: pair.secretKey });
  return [open(registration.encrypted, 'collect', 'configuration'), open(registration.artifact, registration.admission.artifactId, 'artifact')];
}
it('seals the settings and code for its own machine with that machine\'s automation key', async () => {
  for (const opened of await registered(pair)) {
    expect(opened).toMatchObject({ ok: true, authentication: { kind: 'authenticated', senderPublicKey: pair.publicKey } });
  }
});
it('seals anonymously when the target is another machine, whose key it does not hold', async () => {
  for (const opened of await registered(nacl.box.keyPair())) {
    expect(opened).toMatchObject({ ok: true, authentication: { kind: 'anonymous' } });
  }
});

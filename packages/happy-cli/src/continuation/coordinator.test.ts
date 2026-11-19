import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrossAgentContinuation, type CrossAgentSpawn } from './coordinator';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
 const root = await mkdtemp(join(tmpdir(), 'paws-carry-')); dirs.push(root);
 let spawns = 0; let exports = 0;
 const source = { id: 'source', agent: 'claude' as const, nativeId: 'native', directory: '/work', running: false, application: false };
 const deps: Parameters<typeof createCrossAgentContinuation>[0] = { root, resolveSource: async () => source, exportHistory: async () => { exports++; return [{ kind: 'user' as const, text: 'task' }]; }, spawn: async (_options: CrossAgentSpawn) => { spawns++; return { type: 'success' as const, sessionId: 'target' }; } };
 return { deps, source, counts: () => ({ spawns, exports }) };
}
const request = { sourceSessionId: 'source', targetAgent: 'codex' as const, requestId: 'a1229d66-6ecb-4bb5-90f8-791b78125502' };
describe('new linked cross-agent sessions', () => {
 it('coalesces concurrent retries and retains a durable receipt across coordinator restart', async () => {
  const { deps, counts } = await setup(); const run = createCrossAgentContinuation(deps);
  expect(await Promise.all([run(request), run(request)])).toEqual([{ type: 'success', sessionId: 'target' }, { type: 'success', sessionId: 'target' }]);
  expect(await createCrossAgentContinuation(deps)(request)).toEqual({ type: 'success', sessionId: 'target' });
  expect(counts()).toEqual({ spawns: 1, exports: 1 });
 });
 it('refuses running and application-owned sources before reading history or spawning', async () => {
  const { deps, source, counts } = await setup(); source.running = true;
  await expect(createCrossAgentContinuation(deps)(request)).rejects.toThrow(/finish|running/i);
  source.running = false; source.application = true;
  await expect(createCrossAgentContinuation(deps)(request)).rejects.toThrow(/application/i);
  expect(counts()).toEqual({ spawns: 0, exports: 0 });
 });
 it('does not create another worker after an ambiguous launch, even after restart', async () => {
  const { deps, counts } = await setup(); deps.spawn = async () => { throw new Error('connection lost after dispatch'); };
  await expect(createCrossAgentContinuation(deps)(request)).rejects.toThrow('connection lost');
  await expect(createCrossAgentContinuation(deps)(request)).rejects.toThrow(/unknown/i);
  await expect(createCrossAgentContinuation(deps)(request)).rejects.toThrow(/unknown/i);
  expect(counts().exports).toBe(1);
 });
 it('passes same directory, source lineage and explicit target, without modifying source', async () => {
  const { deps, source } = await setup(); const before = structuredClone(source); let received: any;
  deps.spawn = async options => { received = options; return { type: 'success', sessionId: 'target' }; };
  await createCrossAgentContinuation(deps)(request);
  expect(received).toMatchObject({ agent: 'codex', directory: '/work', parentSessionId: 'source', crossAgentHistory: [{ kind: 'user', text: 'task' }], approvedNewDirectoryCreation: false });
  expect(source).toEqual(before);
 });
});

it('allows retry after a proven pre-dispatch failure', async () => {
 const { deps } = await setup(); let launches = 0;
 deps.spawn = async () => ++launches === 1 ? { type: 'error', errorMessage: 'import failed before spawn', notDispatched: true } : { type: 'success', sessionId: 'target' };
 const run = createCrossAgentContinuation(deps);
 expect(await run(request)).toMatchObject({ type: 'error' });
 expect(await run(request)).toEqual({ type: 'success', sessionId: 'target' });
 expect(launches).toBe(2);
});

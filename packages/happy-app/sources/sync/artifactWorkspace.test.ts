import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: true, response: {} as unknown, calls: 0 }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => state.current }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: async () => { state.calls++; return state.response; } } }));
import { artifactRequest, artifactInvalidations } from './artifactWorkspace';
beforeEach(() => { state.current = true; state.calls = 0; state.response = {}; });
it('preserves a pending operation ID without silently retrying a mutation', async () => {
  state.response = { ok: false, error: { code: 'PARTIAL_COMMIT', message: 'Recovery required', operationId: 'restore-1' } };
  await expect(artifactRequest('machine', 'artifactRestore', { workspaceId: 'ws', artifactId: 'artifact', versionId: 'old', expectedRevision: 'a'.repeat(64), operationId: 'restore-1' })).rejects.toMatchObject({ detail: { code: 'PARTIAL_COMMIT', operationId: 'restore-1' } });
  expect(state.calls).toBe(1);
});
it('rejects stale-account access before sending and validates bounded resource responses', async () => {
  state.current = false;
  await expect(artifactRequest('machine', 'artifactCapabilities', {})).rejects.toMatchObject({ detail: { code: 'UNAVAILABLE' } });
  expect(state.calls).toBe(0);
  state.current = true;
  state.response = { ok: true, value: { content: 'A'.repeat(400000), totalSize: 300000, sha256: 'b'.repeat(64), offset: 0 } };
  await expect(artifactRequest('machine', 'artifactResourceRead', { workspaceId: 'ws', artifactId: 'artifact', path: 'a.md', readRef: { kind: 'version', versionId: 'old' }, offset: 0, length: 256 })).rejects.toThrow();
});
it('extracts bounded invalidations without carrying file contents', () => {
  const event = { workspaceId: 'ws', artifactId: 'a', currentVersionId: 'v', workingRevision: 'c'.repeat(64), sequence: 7 };
  expect(artifactInvalidations({ artifactChanges: [{ ...event, content: 'must not be used' }] })).toEqual([event]);
  expect(artifactInvalidations({ artifactChanges: Array(65).fill(event) })).toEqual([]);
});
it('classifies local validation and explicit server denials as definite, without dispatching invalid input',async()=>{
 await expect(artifactRequest('machine','artifactRegister',{root:'/p',entryPath:'a.md',managedPaths:Array(129).fill('a.md'),operationId:'x'})).rejects.toMatchObject({detail:{code:'LIMIT_EXCEEDED'},uncertain:false});expect(state.calls).toBe(0);
 state.response={ok:false,error:{code:'UNAVAILABLE',message:'Upgrade old worker'}};await expect(artifactRequest('machine','artifactRestore',{workspaceId:'w',artifactId:'a',operationId:'r',expectedRevision:'a'.repeat(64),versionId:'v'})).rejects.toMatchObject({uncertain:false});
});

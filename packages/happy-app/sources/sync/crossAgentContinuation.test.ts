import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: new Map<string, string>(), spawn: vi.fn(), hydrate: vi.fn(), current: true, state: {} as any }));
vi.mock('react-native-mmkv', () => ({ MMKV: class { getString(k: string) { return h.values.get(k); } set(k: string, v: string) { h.values.set(k,v); } delete(k: string) { h.values.delete(k); } } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (x: string) => x, assertAccountRuntime: () => { if (!h.current) throw new Error('account changed'); } }));
vi.mock('./storage', () => ({ storage: { getState: () => h.state } }));
vi.mock('./ops', () => ({ machineContinueWithAgent: h.spawn }));
vi.mock('./ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: h.hydrate }));
import { createCrossAgentContinuation } from './crossAgentContinuation';
beforeEach(() => {
 h.values.clear(); h.spawn.mockReset(); h.hydrate.mockReset().mockResolvedValue(true); h.current = true;
 h.state = { sessions: { source: { id: 'source', metadata: { machineId: 'm', path: '/work', flavor: 'claude', claudeSessionId: 'native' } } },
  machines: { m: { active: true, metadata: { crossAgentContinuation: 1, cliAvailability: { codex: true } } } } };
});
describe('cross-agent client orchestration', () => {
 it('coalesces clicks and sends only source identity plus an idempotent request', async () => {
  h.spawn.mockResolvedValue({ type: 'success', sessionId: 'new' });
  expect(await Promise.all([createCrossAgentContinuation('source','codex'), createCrossAgentContinuation('source','codex')])).toEqual(['new','new']);
  expect(h.spawn).toHaveBeenCalledOnce();
  expect(h.spawn).toHaveBeenCalledWith({ machineId: 'm', sourceSessionId: 'source', targetAgent: 'codex', requestId: '00000000-0000-4000-8000-000000000001' });
  expect(h.values.size).toBe(0);
 });
 it('reuses the same request after an unknown result, avoiding another remote launch identity', async () => {
  h.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'transport lost', outcomeUnknown: true }).mockResolvedValueOnce({ type: 'success', sessionId: 'created-earlier' });
  await expect(createCrossAgentContinuation('source','codex')).rejects.toThrow('transport lost');
  const saved = h.values.get('source:codex');
  expect(await createCrossAgentContinuation('source','codex')).toBe('created-earlier');
  expect(h.spawn.mock.calls[0][0].requestId).toBe(h.spawn.mock.calls[1][0].requestId);
  expect(saved).not.toContain('grant');
 });
 it('reopens an already created target after hydration failure without spawning again', async () => {
  h.spawn.mockResolvedValue({ type: 'success', sessionId: 'target' }); h.hydrate.mockResolvedValueOnce(false);
  await expect(createCrossAgentContinuation('source','codex')).rejects.toThrow(/not loaded/);
  expect(await createCrossAgentContinuation('source','codex')).toBe('target'); expect(h.spawn).toHaveBeenCalledOnce();
 });
 it('does not navigate or hydrate into an account that changed during the request', async () => {
  h.spawn.mockImplementation(async () => { h.current = false; return { type: 'success', sessionId: 'target' }; });
  await expect(createCrossAgentContinuation('source','codex')).rejects.toThrow('account changed');
  expect(h.hydrate).not.toHaveBeenCalled(); expect(h.values.get('source:codex')).toContain('target');
 });
});

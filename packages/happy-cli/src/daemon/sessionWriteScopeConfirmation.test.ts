import { captureSaycodeAgentEnvironment, buildSessionSpawnEnvironment } from './sessionEnv';
import { describe, expect, it, vi } from 'vitest';
import { takeScopeConfirmation, confirmSessionWriteScope } from './sessionWriteScopeConfirmation';

vi.mock('./browserClient', () => ({ readDaemonControlPort: vi.fn(async () => null) }));
describe('scope provider receipt', () => {
  it('removes confirmation and host bootstrap material before agent environment is cloned', () => {
    const env = { HAPPY_WRITE_SCOPE_APPLY_TOKEN: 'private', HAPPY_WRITE_SCOPE_PROFILE_DIGEST: 'digest',
      HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY: 'public', HAPPY_WRITE_SCOPE_SESSION: '1', APLUS_SESSION_ID: 'session' };
    expect(takeScopeConfirmation(env)).toEqual({ token: 'private', digest: 'digest', sessionId: 'session' });
    expect(env).toEqual({ HAPPY_WRITE_SCOPE_SESSION: '1', APLUS_SESSION_ID: 'session' });
    expect(takeScopeConfirmation(env)).toBeNull();
  });
  it('does not acknowledge a mismatched or unsandboxed provider', async () => {
    const receipt = { token: 'private', digest: 'digest', sessionId: 'session' };
    await expect(confirmSessionWriteScope(receipt, false, undefined)).rejects.toThrow('SCOPE_PROFILE_NOT_PROTECTED');
    await expect(confirmSessionWriteScope(receipt, true, undefined)).rejects.toThrow('SCOPE_PROFILE_NOT_PROTECTED');
  });
  it('persists the original sandbox and scrubs approval lineage for other sessions', () => {
    const env = { HAPPY_PROJECT_SANDBOX_CONFIG: '{"extraWritePaths":["/grant"]}',
      HAPPY_WRITE_SCOPE_BASE_CONFIG: '{"extraWritePaths":[]}', HAPPY_WRITE_SCOPE_SESSION: '1',
      HAPPY_WRITE_SCOPE_APPLY_TOKEN: 'private', HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY: 'public' };
    const captured = captureSaycodeAgentEnvironment(env)!;
    expect(captured.HAPPY_PROJECT_SANDBOX_CONFIG).toBe(env.HAPPY_WRITE_SCOPE_BASE_CONFIG);
    expect(captured.HAPPY_SANDBOX_POLICY_MODE).toBe('mandatory');
    expect(JSON.stringify(captured)).not.toContain('private');
    const next = buildSessionSpawnEnvironment(env, {});
    expect(next.HAPPY_WRITE_SCOPE_APPLY_TOKEN).toBeUndefined();
    expect(next.HAPPY_WRITE_SCOPE_SESSION).toBeUndefined();
  });

});

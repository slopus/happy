import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReadDaemonState: vi.fn(),
  mockClearDaemonState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readDaemonState: mocks.mockReadDaemonState,
  clearDaemonState: mocks.mockClearDaemonState,
}));

import { checkIfDaemonRunningAndCleanupStaleState, launchDelegationDaemonSession, spawnDaemonSession } from './controlClient';

describe('parent-bound delegation control client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockReadDaemonState.mockResolvedValue({ pid: 12345, httpPort: 54321 });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, roles: [] }) }));
  });

  it('preserves handoff text separately from the execution context and binds the actual parent', async () => {
    const action = { action: 'start' as const, roleId: 'writer', requestId: 'request', prompt: 'Draft', context: 'Verified project facts', wait: true };
    const executionContext = { permissionMode: 'read-only' as const, appendSystemPrompt: 'Inherited task rules' };
    await launchDelegationDaemonSession('actual-parent', { ...action, parentSessionId: 'forged-parent' } as any, executionContext);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(options!.body as string)).toEqual({ ...action, parentSessionId: 'actual-parent', delegationContext: executionContext });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  it('retains the existing task id on a transport failure and never retries the launch', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Connection lost'));
    const response = await launchDelegationDaemonSession('parent', { action: 'start', taskId: 'existing-task', requestId: 'same-request', prompt: 'Revise', wait: true });
    expect(response).toMatchObject({ success: false, taskId: 'existing-task', error: expect.stringContaining('Connection lost') });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('spawnDaemonSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockReadDaemonState.mockResolvedValue({
      pid: 12345,
      httpPort: 54321,
    });
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, sessionId: 'happy-session-123' }),
    }));
  });

  it('passes resume ids to the daemon control server', async () => {
    await spawnDaemonSession({
      directory: '/repo',
      agent: 'codex',
      resumeCodexThreadId: 'codex-thread-123',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:54321/spawn-session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          directory: '/repo',
          agent: 'codex',
          resumeCodexThreadId: 'codex-thread-123',
        }),
      }),
    );
  });
});

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockReadDaemonState.mockResolvedValue({
      pid: 12345,
      httpPort: 54321,
    });
  });

  it('keeps daemon ownership when the PID is alive but the HTTP health check is transiently unavailable', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timed out')));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled();
  });

  it('cleans up daemon ownership when the recorded PID is no longer alive', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);
    expect(mocks.mockClearDaemonState).toHaveBeenCalledTimes(1);
  });
});

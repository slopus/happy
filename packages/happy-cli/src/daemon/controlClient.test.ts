import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockReadDaemonState: vi.fn(),
  mockClearDaemonState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readDaemonState: mocks.mockReadDaemonState,
  clearDaemonState: mocks.mockClearDaemonState,
}));

import { checkIfDaemonRunningAndCleanupStaleState, spawnDaemonSession } from './controlClient';

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

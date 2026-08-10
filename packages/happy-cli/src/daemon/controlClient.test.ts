import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearDaemonState: vi.fn(),
  loggerDebug: vi.fn(),
  readDaemonState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  clearDaemonState: mocks.clearDaemonState,
  readDaemonState: mocks.readDaemonState,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    currentCliVersion: '1.2.0',
  },
}));

import {
  checkIfDaemonRunningAndCleanupStaleState,
  isDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon,
} from './controlClient';

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  const state = {
    pid: 424242,
    httpPort: 12345,
    startTime: 'now',
    startedWithCliVersion: '1.2.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDaemonState.mockResolvedValue(state);
    mocks.clearDaemonState.mockResolvedValue(true);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps a daemon whose control server responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);

    expect(mocks.clearDaemonState).not.toHaveBeenCalled();
  });

  it('preserves state after an inconclusive HTTP timeout for a live PID', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);

    expect(mocks.clearDaemonState).not.toHaveBeenCalled();
    expect(mocks.loggerDebug).toHaveBeenCalledWith(expect.stringContaining('preserving daemon state'));
  });

  it('cleans stale state when a live reused PID has no listener on the recorded port', async () => {
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionError));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);

    expect(mocks.clearDaemonState).toHaveBeenCalledWith(state.pid);
  });

  it('does not replace or kill an unverified PID when ownership-safe cleanup fails', async () => {
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    mocks.clearDaemonState.mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionError));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true);

    expect(mocks.clearDaemonState).toHaveBeenCalledWith(state.pid);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith(state.pid, 0);
  });

  it('refuses version-mismatch replacement while daemon identity is indeterminate', async () => {
    const connectionError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    mocks.readDaemonState.mockResolvedValue({ ...state, startedWithCliVersion: '0.0.1' });
    mocks.clearDaemonState.mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionError));

    await expect(isDaemonRunningCurrentlyInstalledHappyVersion()).resolves.toBe(true);

    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.stringContaining('refusing automatic replacement'),
    );
  });

  it('cleans stale state when the recorded PID is no longer alive', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error('ESRCH');
    });
    vi.stubGlobal('fetch', vi.fn());

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);

    expect(mocks.clearDaemonState).toHaveBeenCalledWith(state.pid);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows lock-protected startup after a dead PID even when stale cleanup lost ownership', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error('ESRCH');
    });
    mocks.clearDaemonState.mockResolvedValue(false);

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);

    expect(mocks.clearDaemonState).toHaveBeenCalledWith(state.pid);
  });

  it('never force-kills an unverified PID during automatic replacement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('control endpoint unavailable')));

    await stopDaemon({ allowForceKill: false });

    expect(process.kill).not.toHaveBeenCalledWith(state.pid, 'SIGKILL');
    expect(mocks.loggerDebug).toHaveBeenCalledWith(
      expect.stringContaining('will not force-kill'),
    );
  });
});

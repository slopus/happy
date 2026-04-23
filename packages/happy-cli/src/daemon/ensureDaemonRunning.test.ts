import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsDaemonRunningCurrentlyInstalledHappyVersion = vi.fn();
const mockStopDaemon = vi.fn();
const mockReadDaemonState = vi.fn();
const mockSpawnHappyCLI = vi.fn();
const mockUnref = vi.fn();

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon: mockStopDaemon,
}));

vi.mock('@/persistence', () => ({
  readDaemonState: mockReadDaemonState,
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mockSpawnHappyCLI,
}));

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    mockSpawnHappyCLI.mockReturnValue({ unref: mockUnref });
    mockStopDaemon.mockResolvedValue(undefined);
    mockReadDaemonState.mockResolvedValue({
      pid: 123,
      httpPort: 456,
      startTime: 'now',
      startedWithCliVersion: '1.1.6',
      startedFromCwd: process.cwd(),
    });
  });

  it('does nothing when the daemon version matches and cwd is unchanged', async () => {
    mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true);

    const { ensureDaemonRunning } = await import('./ensureDaemonRunning');
    await ensureDaemonRunning();

    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(mockSpawnHappyCLI).not.toHaveBeenCalled();
  });

  it('restarts the daemon when the current cwd changed', async () => {
    mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true);
    mockReadDaemonState.mockResolvedValue({
      pid: 123,
      httpPort: 456,
      startTime: 'now',
      startedWithCliVersion: '1.1.6',
      startedFromCwd: '/tmp/other-project',
    });

    const { ensureDaemonRunning } = await import('./ensureDaemonRunning');
    const promise = ensureDaemonRunning();
    await vi.runAllTimersAsync();
    await promise;

    expect(mockStopDaemon).toHaveBeenCalledTimes(1);
    expect(mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('restarts the daemon once for older state files without a remembered cwd', async () => {
    mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true);
    mockReadDaemonState.mockResolvedValue({
      pid: 123,
      httpPort: 456,
      startTime: 'now',
      startedWithCliVersion: '1.1.6',
    });

    const { ensureDaemonRunning } = await import('./ensureDaemonRunning');
    const promise = ensureDaemonRunning();
    await vi.runAllTimersAsync();
    await promise;

    expect(mockStopDaemon).toHaveBeenCalledTimes(1);
    expect(mockSpawnHappyCLI).toHaveBeenCalledTimes(1);
  });

  it('starts the daemon when none is running', async () => {
    mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);

    const { ensureDaemonRunning } = await import('./ensureDaemonRunning');
    const promise = ensureDaemonRunning();
    await vi.runAllTimersAsync();
    await promise;

    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(mockSpawnHappyCLI).toHaveBeenCalledTimes(1);
  });
});

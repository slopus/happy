import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleSigkillFallback } from './processLifecycle';

describe('scheduleSigkillFallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the SIGKILL fallback when the child exits during the grace window', () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const killProcess = vi.fn();

    scheduleSigkillFallback({
      pid: 12345,
      sessionId: 'session1',
      childProcess: child,
      graceMs: 3_000,
      killProcess,
      log: vi.fn(),
    });

    child.emit('exit', 0, null);
    vi.advanceTimersByTime(3_000);

    expect(child.kill).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('does not schedule a PID-only SIGKILL fallback without a child process handle', () => {
    vi.useFakeTimers();
    const killProcess = vi.fn();

    scheduleSigkillFallback({
      pid: 12345,
      sessionId: 'external-session',
      graceMs: 3_000,
      killProcess,
      log: vi.fn(),
    });

    vi.advanceTimersByTime(3_000);

    expect(killProcess).not.toHaveBeenCalled();
  });

  it('still sends SIGKILL when SIGTERM was sent but the child has not exited', () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = true;
    child.kill = vi.fn();
    const killProcess = vi.fn();

    scheduleSigkillFallback({
      pid: 12345,
      sessionId: 'session1',
      childProcess: child,
      graceMs: 3_000,
      killProcess,
      log: vi.fn(),
    });

    vi.advanceTimersByTime(3_000);

    expect(killProcess).toHaveBeenCalledWith(12345, 0);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => true);
}

describe('terminateProcess', () => {
  it('sends SIGKILL after grace when the process is still running', async () => {
    vi.useFakeTimers();
    const child = new FakeChild() as any;

    const { terminateProcess } = await import('./terminateProcess');
    const p = terminateProcess(child, { graceMs: 250 });

    await vi.advanceTimersByTimeAsync(251);
    await p;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('does not SIGKILL when the process exits during grace', async () => {
    vi.useFakeTimers();
    const child = new FakeChild() as any;

    const { terminateProcess } = await import('./terminateProcess');
    const p = terminateProcess(child, { graceMs: 250 });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1);
    await p;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('does nothing when the process is already exited', async () => {
    const child = new FakeChild() as any;
    child.exitCode = 0;

    const { terminateProcess } = await import('./terminateProcess');
    await terminateProcess(child);

    expect(child.kill).not.toHaveBeenCalled();
  });
});


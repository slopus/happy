import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupStdinAfterInk } from './cleanupStdinAfterInk';

function createFakeStdin() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const calls: Array<{ name: string; args: any[] }> = [];

  const api = {
    isTTY: true,
    on: (event: string, fn: (...args: any[]) => void) => {
      calls.push({ name: 'on', args: [event] });
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return api as any;
    },
    off: (event: string, fn: (...args: any[]) => void) => {
      calls.push({ name: 'off', args: [event] });
      listeners.get(event)?.delete(fn);
      return api as any;
    },
    resume: () => {
      calls.push({ name: 'resume', args: [] });
    },
    pause: () => {
      calls.push({ name: 'pause', args: [] });
    },
    setRawMode: (value: boolean) => {
      calls.push({ name: 'setRawMode', args: [value] });
    },
    __calls: calls,
    __listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };

  return api;
}

describe('cleanupStdinAfterInk', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains buffered input and pauses stdin', async () => {
    vi.useFakeTimers();
    const stdin = createFakeStdin();

    const promise = cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(stdin.__calls.some((c) => c.name === 'setRawMode' && c.args[0] === false)).toBe(true);
    expect(stdin.__calls.some((c) => c.name === 'resume')).toBe(true);
    expect(stdin.__calls.some((c) => c.name === 'pause')).toBe(true);
    expect(stdin.__listenerCount('data')).toBe(0);
  });

  it('is a no-op when stdin is not a TTY', async () => {
    const stdin = createFakeStdin();
    (stdin as any).isTTY = false;
    await cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 50 });
    expect(stdin.__calls.length).toBe(0);
  });
});

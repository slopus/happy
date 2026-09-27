import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSessionStartTimeoutConfig, waitForSessionWebhook } from './spawnWebhookWait';

const session = {
  startedBy: 'daemon',
  happySessionId: 'session-1',
  pid: 123,
} as any;

describe('spawn webhook wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 15s soft timeout and 60s final timeout by default', () => {
    expect(readSessionStartTimeoutConfig({})).toEqual({
      softTimeoutMs: 15_000,
      finalTimeoutMs: 60_000,
    });
  });

  it('reads timeout overrides and keeps the final timeout after the soft timeout', () => {
    expect(readSessionStartTimeoutConfig({
      SESSION_START_SOFT_TIMEOUT_MS: '30000',
      SESSION_START_TIMEOUT_MS: '10000',
    })).toEqual({
      softTimeoutMs: 30_000,
      finalTimeoutMs: 30_001,
    });
  });

  it('keeps waiting after the soft timeout and resolves a delayed webhook as success', async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    const awaiters = new Map<number, (s: any) => void>();

    const result = waitForSessionWebhook({
      pid: 123,
      pidToAwaiter: awaiters,
      logger,
      timeouts: { softTimeoutMs: 15, finalTimeoutMs: 60 },
    });

    await vi.advanceTimersByTimeAsync(16);
    expect(awaiters.has(123)).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('still pending'));

    awaiters.get(123)?.(session);

    await expect(result).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('delayed webhook'));
  });

  it('returns an error only after the final timeout', async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    const awaiters = new Map<number, (s: any) => void>();

    const result = waitForSessionWebhook({
      pid: 123,
      pidToAwaiter: awaiters,
      logger,
      timeouts: { softTimeoutMs: 15, finalTimeoutMs: 60 },
    });

    await vi.advanceTimersByTimeAsync(59);
    expect(awaiters.has(123)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      type: 'error',
      errorMessage: 'Session webhook timeout for PID 123',
    });
    expect(awaiters.has(123)).toBe(false);
  });
  it('cancels the webhook waiter and both timers when native resume fails', async () => {
    vi.useFakeTimers(); const logger = { debug: vi.fn() }; const awaiters = new Map<number, (s: any) => void>();
    const cancellation = new AbortController();
    const result = waitForSessionWebhook({ pid: 123, pidToAwaiter: awaiters, logger, signal: cancellation.signal,
      timeouts: { softTimeoutMs: 15, finalTimeoutMs: 60 } });
    cancellation.abort();
    expect(await result).toEqual({ type: 'error', errorMessage: 'Session startup cancelled for PID 123' });
    expect(awaiters.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('timeout'));
  });
  it('cancelling an old waiter does not delete a replacement waiter for the same PID', async () => {
    vi.useFakeTimers(); const awaiters = new Map<number, (s: any) => void>(); const cancellation = new AbortController();
    const result = waitForSessionWebhook({ pid: 123, pidToAwaiter: awaiters, logger: { debug: vi.fn() }, signal: cancellation.signal });
    const replacement = vi.fn(); awaiters.set(123, replacement); cancellation.abort(); await result;
    expect(awaiters.get(123)).toBe(replacement); expect(vi.getTimerCount()).toBe(0);
  });

});

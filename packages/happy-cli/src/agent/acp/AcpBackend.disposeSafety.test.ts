import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { AcpBackend } from './AcpBackend';

function createBackend(extraOptions: Partial<ConstructorParameters<typeof AcpBackend>[0]> = {}): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: '/tmp',
    command: '/bin/true',
    ...extraOptions,
  });
}

function captureEvents(backend: AcpBackend): AgentMessage[] {
  const events: AgentMessage[] = [];
  backend.onMessage((msg) => events.push(msg));
  return events;
}

describe('AcpBackend dispose safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('createHandlerContext.setIdleTimeout — callback does NOT fire after dispose', async () => {
    const backend = createBackend();
    const events = captureEvents(backend);
    const ctx = (backend as unknown as { createHandlerContext(): { setIdleTimeout(cb: () => void, ms: number): void; emitIdleStatus(): void } }).createHandlerContext();

    const callback = vi.fn();
    ctx.setIdleTimeout(callback, 500);

    // Dispose before the timer fires (don't await — dispose's process.kill
    // paths take real time; we just need the synchronous `disposed = true`).
    void backend.dispose();
    expect((backend as unknown as { disposed: boolean }).disposed).toBe(true);

    // Advance past the would-be fire moment.
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'status' && (e as { status: string }).status === 'idle')).toBe(false);
  });

  it('createHandlerContext.setIdleTimeout — scheduling AFTER dispose is a no-op', () => {
    const backend = createBackend();
    const ctx = (backend as unknown as { createHandlerContext(): { setIdleTimeout(cb: () => void, ms: number): void } }).createHandlerContext();

    void backend.dispose();
    const callback = vi.fn();
    ctx.setIdleTimeout(callback, 100);

    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('createHandlerContext.emitIdleStatus — gated on disposed', () => {
    const backend = createBackend();
    const events = captureEvents(backend);
    const ctx = (backend as unknown as { createHandlerContext(): { emitIdleStatus(): void } }).createHandlerContext();

    void backend.dispose();
    ctx.emitIdleStatus();

    expect(events.some((e) => e.type === 'status' && (e as { status: string }).status === 'idle')).toBe(false);
  });

  it('dispose() calls permissionHandler.reset() to unblock pending RPC awaits', async () => {
    const reset = vi.fn();
    const permissionHandler = {
      handleToolCall: vi.fn(),
      reset,
      abortAll: vi.fn(),
      updateSession: vi.fn(),
    };

    const backend = createBackend({
      permissionHandler: permissionHandler as unknown as ConstructorParameters<typeof AcpBackend>[0]['permissionHandler'],
    });

    await backend.dispose();
    expect(reset).toHaveBeenCalledOnce();
    expect(reset.mock.calls[0][0]).toMatch(/dispose/i);
  });

  it('dispose() tolerates permissionHandler.reset() throwing (does not block subsequent cleanup)', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn(),
      reset: vi.fn(() => {
        throw new Error('boom from reset');
      }),
      abortAll: vi.fn(),
      updateSession: vi.fn(),
    };

    const backend = createBackend({
      permissionHandler: permissionHandler as unknown as ConstructorParameters<typeof AcpBackend>[0]['permissionHandler'],
    });

    await expect(backend.dispose()).resolves.toBeUndefined();
    expect((backend as unknown as { disposed: boolean }).disposed).toBe(true);
  });
});

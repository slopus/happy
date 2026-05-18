import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { AcpBackend } from './AcpBackend';

function createBackend(): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: '/tmp',
    command: '/bin/true',
  });
}

function captureEvents(backend: AcpBackend): AgentMessage[] {
  const events: AgentMessage[] = [];
  backend.onMessage((msg) => events.push(msg));
  return events;
}

// `handleSessionUpdate` is a private method on AcpBackend; cast to access for unit tests.
function dispatchUpdate(backend: AcpBackend, update: Record<string, unknown>): void {
  (backend as unknown as { handleSessionUpdate(params: unknown): void }).handleSessionUpdate({
    sessionId: 'test',
    update,
  });
}

describe('AcpBackend.handleSessionUpdate', () => {
  describe('usage_update routing', () => {
    it('forwards usage_update with size/used as event AgentMessage', () => {
      const backend = createBackend();
      const events = captureEvents(backend);

      dispatchUpdate(backend, {
        sessionUpdate: 'usage_update',
        size: 100000,
        used: 5000,
      });

      expect(events).toEqual([
        {
          type: 'event',
          name: 'usage_update',
          payload: { size: 100000, used: 5000 },
        },
      ]);
    });

    it('includes optional cost when present', () => {
      const backend = createBackend();
      const events = captureEvents(backend);

      dispatchUpdate(backend, {
        sessionUpdate: 'usage_update',
        size: 100000,
        used: 12345,
        cost: { amount: 0.42, currency: 'USD' },
      });

      expect(events[0]).toEqual({
        type: 'event',
        name: 'usage_update',
        payload: {
          size: 100000,
          used: 12345,
          cost: { amount: 0.42, currency: 'USD' },
        },
      });
    });

    it('ignores usage_update with non-numeric size or used', () => {
      const backend = createBackend();
      const events = captureEvents(backend);

      dispatchUpdate(backend, {
        sessionUpdate: 'usage_update',
        size: 'oops',
        used: 5000,
      });

      expect(events).toEqual([]);
    });
  });

  describe('unhandled session update warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {
        // Suppress test output noise.
      });
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns on unknown sessionUpdate type so missing routes surface', () => {
      const backend = createBackend();

      dispatchUpdate(backend, {
        sessionUpdate: 'some_future_type',
        someField: 'value',
      });

      expect(warnSpy).toHaveBeenCalledOnce();
      const message = String(warnSpy.mock.calls[0][0] ?? '');
      expect(message).toContain('Unhandled session update type: some_future_type');
    });

    it('does NOT warn on known types', () => {
      const backend = createBackend();

      dispatchUpdate(backend, {
        sessionUpdate: 'usage_update',
        size: 1,
        used: 1,
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

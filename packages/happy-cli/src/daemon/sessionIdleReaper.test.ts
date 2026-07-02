import { describe, expect, it, vi } from 'vitest';

import {
  buildDaemonSessionIdleReaperRequest,
  runDaemonSessionIdleReaperTick,
} from './sessionIdleReaper';
import type { TrackedSession } from './types';

function tracked(overrides: Partial<TrackedSession>): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 100,
    ...overrides,
  };
}

describe('buildDaemonSessionIdleReaperRequest', () => {
  it('includes only tracked claude/codex sessions with stable lastActiveAt', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
        }),
        tracked({
          pid: 101,
          happySessionId: 'session-codex',
          happySessionMetadataFromLocalWebhook: { flavor: 'codex' } as never,
        }),
        tracked({
          pid: 102,
          happySessionId: 'session-gemini',
          happySessionMetadataFromLocalWebhook: { flavor: 'gemini' } as never,
        }),
        tracked({ pid: 103 }),
      ],
    });

    expect(request).toEqual({
      machineId: 'machine-1',
      sessions: [
        {
          sessionId: 'session-claude',
          agent: 'claude',
          active: true,
          thinking: false,
          hasOpenToolCall: false,
          lastActiveAt: 1_000,
        },
        {
          sessionId: 'session-codex',
          agent: 'codex',
          active: true,
          thinking: false,
          hasOpenToolCall: false,
          lastActiveAt: 10_000,
        },
      ],
    });
  });

  it('passes optional idle and presence thresholds through to the server request', () => {
    expect(buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      idleAfterMs: 123,
      presenceStaleMs: 456,
      sessionStartTimes: new Map(),
      trackedSessions: [],
    })).toEqual({
      machineId: 'machine-1',
      idleAfterMs: 123,
      presenceStaleMs: 456,
      sessions: [],
    });
  });
});

describe('runDaemonSessionIdleReaperTick', () => {
  it('stops only locally tracked server candidates and treats duplicates as no-op', async () => {
    const live = new Set(['session-1']);
    const stopSession = vi.fn((sessionId: string) => live.delete(sessionId));
    const postCandidates = vi.fn(async () => ({
      checkedAt: 20_000,
      candidates: [
        { sessionId: 'session-1', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        { sessionId: 'session-1', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        { sessionId: 'missing', projectId: 'project-1', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
      ],
    }));

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({ pid: 100, happySessionId: 'session-1' })],
      stopSession,
      postCandidates,
    });

    expect(postCandidates).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      requestedSessions: 1,
      candidateSessions: 3,
      stoppedSessions: 1,
      noopSessions: 2,
    });
  });

  it('does not stop sessions when the candidate request fails', async () => {
    const stopSession = vi.fn();
    const logDebug = vi.fn();

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({ pid: 100, happySessionId: 'session-1' })],
      stopSession,
      logDebug,
      postCandidates: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    expect(stopSession).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('network down'));
    expect(result).toEqual({
      requestedSessions: 1,
      candidateSessions: 0,
      stoppedSessions: 0,
      noopSessions: 0,
    });
  });
});

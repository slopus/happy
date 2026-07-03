import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
  buildDaemonSessionIdleReaperRequest,
  readDaemonSessionIdleReaperConfig,
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
  it('includes only tracked claude/codex sessions with start time fallback lastActiveAt', () => {
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

  it('includes runtime busy state reported by tracked sessions', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: {
            thinking: true,
            hasOpenToolCall: true,
            updatedAt: 9_000,
          },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      {
        sessionId: 'session-claude',
        agent: 'claude',
        active: true,
        thinking: true,
        hasOpenToolCall: true,
        lastActiveAt: 9_000,
      },
    ]);
  });

  it('uses recent runtime activity even after the session is no longer busy', () => {
    const request = buildDaemonSessionIdleReaperRequest({
      machineId: 'machine-1',
      now: 10_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [
        tracked({
          pid: 100,
          happySessionId: 'session-claude',
          happySessionMetadataFromLocalWebhook: { flavor: 'claude' } as never,
          runtime: {
            thinking: false,
            hasOpenToolCall: false,
            updatedAt: 9_000,
          },
        }),
      ],
    });

    expect(request.sessions).toEqual([
      {
        sessionId: 'session-claude',
        agent: 'claude',
        active: true,
        thinking: false,
        hasOpenToolCall: false,
        lastActiveAt: 9_000,
      },
    ]);
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

describe('readDaemonSessionIdleReaperConfig', () => {
  it('defaults the idle threshold to 10 minutes for production safety', () => {
    expect(DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS).toBe(10 * 60 * 1000);
    expect(readDaemonSessionIdleReaperConfig({})).toEqual({
      disabled: false,
      idleAfterMs: DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
    });
  });

  it('allows env to override the idle threshold', () => {
    expect(readDaemonSessionIdleReaperConfig({
      HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS: '2500',
    })).toMatchObject({
      idleAfterMs: 2500,
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
      trackedSessions: [tracked({
        pid: 100,
        happySessionId: 'session-1',
        runtime: { thinking: true, hasOpenToolCall: false, updatedAt: 19_000 },
      })],
      stopSession,
      postCandidates,
    });

    expect(postCandidates).toHaveBeenCalledTimes(1);
    expect(postCandidates).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        sessions: [
          expect.objectContaining({
            sessionId: 'session-1',
            thinking: true,
            hasOpenToolCall: false,
          }),
        ],
      }),
    }));
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

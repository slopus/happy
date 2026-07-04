import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
  DEFAULT_IDLE_STOP_HARD_CAP_MS,
  DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
  DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
  buildDaemonSessionIdleReaperRequest,
  evaluateIdleStopGuard,
  isPolicyStopSource,
  readDaemonSessionIdleReaperConfig,
  readIdleStopGuardConfig,
  resolveStopSessionMode,
  runDaemonSessionIdleReaperTick,
  type IdleStopGuardConfig,
} from './sessionIdleReaper';
import type { SessionRuntimeState, TrackedSession } from './types';

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
          pendingUserInput: false,
          lastActiveAt: 1_000,
        },
        {
          sessionId: 'session-codex',
          agent: 'codex',
          active: true,
          thinking: false,
          hasOpenToolCall: false,
          pendingUserInput: false,
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
        pendingUserInput: false,
        lastActiveAt: 9_000,
      },
    ]);
  });

  it('forwards user-activity signals so the server can select candidates from real activity', () => {
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
            pendingUserInput: true,
            lastUserInteractionAt: 8_500,
            mode: 'local',
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
        pendingUserInput: true,
        lastUserInteractionAt: 8_500,
        mode: 'local',
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
        pendingUserInput: false,
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
  it('defaults the idle threshold to 5 minutes for production safety', () => {
    expect(DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS).toBe(5 * 60 * 1000);
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
    const stopSession = vi.fn((sessionId: string) =>
      live.delete(sessionId)
        ? { stopped: true as const }
        : { stopped: false as const, reason: 'not-found' as const });
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
    expect(stopSession).toHaveBeenCalledWith('session-1', { source: 'session-idle-reaper', mode: 'if-idle' });
    expect(result).toEqual({
      requestedSessions: 1,
      candidateSessions: 3,
      stoppedSessions: 1,
      skippedActiveSessions: 0,
      noopSessions: 2,
    });
  });

  it('counts guard refusals separately from no-ops', async () => {
    const stopSession = vi.fn((sessionId: string) => {
      if (sessionId === 'busy') {
        return { stopped: false as const, reason: 'active' as const, guard: 'thinking', activity: { thinking: true, hasOpenToolCall: false, pendingUserInput: false } };
      }
      if (sessionId === 'gone') {
        return { stopped: false as const, reason: 'not-found' as const };
      }
      return { stopped: true as const };
    });

    const result = await runDaemonSessionIdleReaperTick({
      machineId: 'machine-1',
      serverUrl: 'https://aplus.example.com',
      credentialsToken: 'token-1',
      now: 20_000,
      sessionStartTimes: new Map([[100, 1_000]]),
      trackedSessions: [tracked({ pid: 100, happySessionId: 'ok' })],
      stopSession,
      postCandidates: vi.fn(async () => ({
        checkedAt: 20_000,
        candidates: [
          { sessionId: 'ok', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'busy', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
          { sessionId: 'gone', projectId: 'p', machineId: 'machine-1', lastActiveAt: 1_000, idleMs: 19_000 },
        ],
      })),
    });

    expect(result).toMatchObject({
      stoppedSessions: 1,
      skippedActiveSessions: 1,
      noopSessions: 1,
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
      skippedActiveSessions: 0,
      noopSessions: 0,
    });
  });
});

describe('isPolicyStopSource / resolveStopSessionMode', () => {
  it('treats idle/cleanup policy sources as policy stops', () => {
    expect(isPolicyStopSource('project-session-idle-stop')).toBe(true);
    expect(isPolicyStopSource('session-idle-reaper')).toBe(true);
    expect(isPolicyStopSource('some-idle-thing')).toBe(true);
    expect(isPolicyStopSource(undefined)).toBe(false);
    expect(isPolicyStopSource('user')).toBe(false);
    expect(isPolicyStopSource('mobile-app')).toBe(false);
  });

  it('defaults to force, infers if-idle from policy source, and honors explicit mode', () => {
    expect(resolveStopSessionMode()).toBe('force');
    expect(resolveStopSessionMode({})).toBe('force');
    expect(resolveStopSessionMode({ source: 'mobile-app' })).toBe('force');
    // A policy source with no explicit mode must never get force semantics.
    expect(resolveStopSessionMode({ source: 'project-session-idle-stop' })).toBe('if-idle');
    // Explicit mode always wins.
    expect(resolveStopSessionMode({ source: 'project-session-idle-stop', mode: 'force' })).toBe('force');
    expect(resolveStopSessionMode({ source: 'user', mode: 'if-idle' })).toBe('if-idle');
  });
});

describe('readIdleStopGuardConfig', () => {
  it('applies conservative defaults and protects local sessions by default', () => {
    expect(readIdleStopGuardConfig({})).toEqual({
      idleAfterMs: DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
      minSessionAgeMs: DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
      hardCapMs: DEFAULT_IDLE_STOP_HARD_CAP_MS,
      presenceStaleMs: DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
      protectLocalSessions: true,
    });
  });

  it('reads overrides and lets local protection be turned off explicitly', () => {
    expect(readIdleStopGuardConfig({
      HAPPY_DAEMON_SESSION_IDLE_MIN_AGE_MS: '1000',
      HAPPY_DAEMON_SESSION_IDLE_HARD_CAP_MS: '2000',
      HAPPY_DAEMON_SESSION_IDLE_PRESENCE_STALE_MS: '3000',
      HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL: 'false',
    })).toMatchObject({
      minSessionAgeMs: 1000,
      hardCapMs: 2000,
      presenceStaleMs: 3000,
      protectLocalSessions: false,
    });
  });
});

describe('evaluateIdleStopGuard', () => {
  const config: IdleStopGuardConfig = {
    idleAfterMs: 30 * 60 * 1000,
    minSessionAgeMs: 10 * 60 * 1000,
    hardCapMs: 2 * 60 * 60 * 1000,
    presenceStaleMs: 5 * 60 * 1000,
    protectLocalSessions: true,
  };

  const now = 10_000_000;
  const old = now - config.hardCapMs - 1; // ancient: past the zombie hard cap
  const withinCap = now - 20 * 60 * 1000; // past min age (10m) but within hard cap (2h)

  function runtime(overrides: Partial<SessionRuntimeState>): SessionRuntimeState {
    return { thinking: false, hasOpenToolCall: false, updatedAt: now, ...overrides };
  }

  it('allows a stop for a quiet, old-enough session with a fresh runtime report', () => {
    expect(evaluateIdleStopGuard({
      runtime: runtime({}),
      sessionStartedAt: withinCap,
      now,
      config,
    })).toEqual({ allow: true });
  });

  it.each([
    ['thinking', runtime({ thinking: true })],
    ['open-tool-call', runtime({ hasOpenToolCall: true })],
    ['pending-user-input', runtime({ pendingUserInput: true })],
  ] as const)('denies when %s (hard block, even for an old session)', (guard, rt) => {
    expect(evaluateIdleStopGuard({ runtime: rt, sessionStartedAt: old, now, config }))
      .toEqual({ allow: false, guard, activity: expect.any(Object) });
  });

  it('denies a session the user interacted with recently', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({ lastUserInteractionAt: now - 60_000 }),
      sessionStartedAt: withinCap,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'recent-user-interaction' });
  });

  it('denies a freshly spawned session below the minimum age', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({}),
      sessionStartedAt: now - 60_000,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'min-session-age' });
  });

  it('denies a session with an attached local terminal when protection is on', () => {
    const decision = evaluateIdleStopGuard({
      runtime: runtime({ mode: 'local' }),
      sessionStartedAt: withinCap,
      now,
      config,
    });
    expect(decision).toMatchObject({ allow: false, guard: 'local-session' });
  });

  it('denies when the runtime report is missing or stale within the hard cap', () => {
    expect(evaluateIdleStopGuard({
      runtime: undefined,
      sessionStartedAt: now - 20 * 60 * 1000,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'stale-runtime' });

    expect(evaluateIdleStopGuard({
      runtime: runtime({ updatedAt: now - config.presenceStaleMs - 1 }),
      sessionStartedAt: now - 20 * 60 * 1000,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'stale-runtime' });
  });

  it('allows cleanup past the hard cap even when soft protections would apply', () => {
    // Local + recent interaction + stale runtime, but the session is ancient.
    expect(evaluateIdleStopGuard({
      runtime: runtime({ mode: 'local', lastUserInteractionAt: now, updatedAt: now - config.presenceStaleMs - 1 }),
      sessionStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toEqual({ allow: true });
  });

  it('still hard-blocks an ancient session that is actively working', () => {
    expect(evaluateIdleStopGuard({
      runtime: runtime({ hasOpenToolCall: true }),
      sessionStartedAt: now - config.hardCapMs - 1,
      now,
      config,
    })).toMatchObject({ allow: false, guard: 'open-tool-call' });
  });
});

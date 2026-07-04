import axios from 'axios';

import type { SessionRuntimeState, TrackedSession } from './types';

export const DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_IDLE_STOP_HARD_CAP_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_IDLE_STOP_PRESENCE_STALE_MS = 5 * 60 * 1000;

type DaemonSessionIdleReaperObservedSession = {
  sessionId: string;
  agent: 'claude' | 'codex';
  active: true;
  thinking: boolean;
  hasOpenToolCall: boolean;
  /** Waiting on the user (AskUserQuestion / permission prompt) — the server
   *  must treat this as busy, not idle, when selecting stop candidates. */
  pendingUserInput: boolean;
  /** Last real user action (prompt sent, question/permission answered) — lets
   *  the server compute idleness from user activity instead of liveness. */
  lastUserInteractionAt?: number;
  /** 'local' = terminal attached. Sent for observability; local protection is
   *  enforced daemon-side via HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL. */
  mode?: 'local' | 'remote';
  lastActiveAt: number;
};

export type DaemonSessionIdleReaperRequest = {
  machineId: string;
  sessions: DaemonSessionIdleReaperObservedSession[];
  idleAfterMs?: number;
  presenceStaleMs?: number;
};

type DaemonSessionIdleReaperCandidate = {
  sessionId: string;
  projectId: string;
  machineId: string;
  lastActiveAt: number;
  idleMs: number;
};

type DaemonSessionIdleReaperResponse = {
  checkedAt: number;
  candidates: DaemonSessionIdleReaperCandidate[];
};

type PostCandidatesInput = {
  serverUrl: string;
  credentialsToken: string;
  request: DaemonSessionIdleReaperRequest;
};

type RunDaemonSessionIdleReaperTickInput = {
  machineId: string;
  serverUrl: string;
  credentialsToken: string;
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  now?: number;
  idleAfterMs?: number;
  presenceStaleMs?: number;
  postCandidates?: (input: PostCandidatesInput) => Promise<DaemonSessionIdleReaperResponse>;
  logDebug?: (message: string) => void;
};

export type DaemonSessionIdleReaperTickResult = {
  requestedSessions: number;
  candidateSessions: number;
  stoppedSessions: number;
  /** Candidates the daemon refused to stop because its local guard saw activity. */
  skippedActiveSessions: number;
  noopSessions: number;
};

export type StopSessionMode = 'force' | 'if-idle';

/**
 * Context carried alongside a stop request. `mode` decides whether the daemon
 * re-validates before killing: 'force' stops unconditionally (user-initiated),
 * 'if-idle' runs the local idle guard first (policy-initiated). When `mode` is
 * absent it is inferred from `source` — any idle/cleanup policy source is
 * treated as if-idle so a batch policy can never get force semantics by omission.
 */
export type StopSessionContext = {
  source?: string;
  reason?: string;
  mode?: StopSessionMode;
};

export type StopSessionResult =
  | { stopped: true }
  | { stopped: false; reason: 'not-found' }
  | { stopped: false; reason: 'active'; guard: string; activity: IdleStopGuardActivity };

const POLICY_STOP_SOURCES = new Set(['project-session-idle-stop', 'session-idle-reaper']);

/** True when a stop source is a background cleanup policy rather than a user action. */
export function isPolicyStopSource(source: unknown): boolean {
  if (typeof source !== 'string') return false;
  const normalized = source.toLowerCase();
  return POLICY_STOP_SOURCES.has(normalized) || normalized.includes('idle');
}

export function resolveStopSessionMode(context?: StopSessionContext): StopSessionMode {
  if (context?.mode === 'force' || context?.mode === 'if-idle') return context.mode;
  return isPolicyStopSource(context?.source) ? 'if-idle' : 'force';
}

export type IdleStopGuardConfig = {
  idleAfterMs: number;
  minSessionAgeMs: number;
  hardCapMs: number;
  presenceStaleMs: number;
  protectLocalSessions: boolean;
};

export type IdleStopGuardActivity = {
  thinking: boolean;
  hasOpenToolCall: boolean;
  pendingUserInput: boolean;
  lastUserInteractionAt?: number;
  mode?: 'local' | 'remote';
  runtimeUpdatedAt?: number;
  sessionAgeMs?: number;
};

export type IdleStopGuardDecision =
  | { allow: true }
  | { allow: false; guard: string; activity: IdleStopGuardActivity };

export function readIdleStopGuardConfig(env: NodeJS.ProcessEnv = process.env): IdleStopGuardConfig {
  return {
    idleAfterMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS)
      ?? DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
    minSessionAgeMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_MIN_AGE_MS)
      ?? DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
    hardCapMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_HARD_CAP_MS)
      ?? DEFAULT_IDLE_STOP_HARD_CAP_MS,
    presenceStaleMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_PRESENCE_STALE_MS)
      ?? DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
    protectLocalSessions: !isExplicitlyFalse(env.HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL),
  };
}

/**
 * Decide whether a policy-initiated stop is allowed for a session, based purely
 * on the session's locally-observed runtime state. The daemon is the only
 * component that owns the child process and sees cross-surface activity
 * (terminal, mobile, app), so it has the final word over cleanup policies.
 *
 * Hard blocks (thinking / open tool call / pending user input) always deny.
 * Past `hardCapMs` with no such signal, a session is treated as a zombie and
 * allowed so genuine leaks still get cleaned up. Within the hard cap, soft
 * protections (recent user interaction, minimum age, attached local terminal,
 * stale/unknown runtime) deny.
 */
export function evaluateIdleStopGuard(input: {
  runtime?: SessionRuntimeState;
  sessionStartedAt?: number;
  now: number;
  config: IdleStopGuardConfig;
}): IdleStopGuardDecision {
  const { runtime, sessionStartedAt, now, config } = input;

  const activity: IdleStopGuardActivity = {
    thinking: runtime?.thinking === true,
    hasOpenToolCall: runtime?.hasOpenToolCall === true,
    pendingUserInput: runtime?.pendingUserInput === true,
    ...(runtime?.lastUserInteractionAt !== undefined ? { lastUserInteractionAt: runtime.lastUserInteractionAt } : {}),
    ...(runtime?.mode !== undefined ? { mode: runtime.mode } : {}),
    ...(runtime?.updatedAt !== undefined ? { runtimeUpdatedAt: runtime.updatedAt } : {}),
    ...(sessionStartedAt !== undefined ? { sessionAgeMs: now - sessionStartedAt } : {}),
  };

  const deny = (guard: string): IdleStopGuardDecision => ({ allow: false, guard, activity });

  if (activity.thinking) return deny('thinking');
  if (activity.hasOpenToolCall) return deny('open-tool-call');
  if (activity.pendingUserInput) return deny('pending-user-input');

  const { sessionAgeMs } = activity;

  // Zombie escape hatch: past the hard cap with no busy signal, allow cleanup
  // even when the soft protections below would otherwise apply.
  if (sessionAgeMs !== undefined && sessionAgeMs >= config.hardCapMs) {
    return { allow: true };
  }

  if (activity.lastUserInteractionAt !== undefined
    && now - activity.lastUserInteractionAt < config.idleAfterMs) {
    return deny('recent-user-interaction');
  }
  if (sessionAgeMs !== undefined && sessionAgeMs < config.minSessionAgeMs) {
    return deny('min-session-age');
  }
  if (config.protectLocalSessions && activity.mode === 'local') {
    return deny('local-session');
  }
  // Unknown or stale runtime within the hard cap is treated as not-idle: absence
  // of a fresh activity report is not evidence that the session is abandoned.
  if (runtime === undefined || now - runtime.updatedAt > config.presenceStaleMs) {
    return deny('stale-runtime');
  }

  return { allow: true };
}

export type DaemonSessionIdleReaperConfig = {
  disabled: boolean;
  idleAfterMs?: number;
  presenceStaleMs?: number;
};

export function readDaemonSessionIdleReaperConfig(env: NodeJS.ProcessEnv = process.env): DaemonSessionIdleReaperConfig {
  const idleAfterMs = parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS);
  const presenceStaleMs = parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_PRESENCE_STALE_MS);
  return {
    disabled: isTruthy(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_DISABLED),
    idleAfterMs: idleAfterMs ?? DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
    ...(presenceStaleMs !== undefined ? { presenceStaleMs } : {}),
  };
}

export function buildDaemonSessionIdleReaperRequest(input: {
  machineId: string;
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  now?: number;
  idleAfterMs?: number;
  presenceStaleMs?: number;
}): DaemonSessionIdleReaperRequest {
  const now = input.now ?? Date.now();
  const sessions: DaemonSessionIdleReaperObservedSession[] = [];

  for (const session of input.trackedSessions) {
    if (!session.happySessionId) continue;

    const agent = resolveStoppableAgent(session);
    if (!agent) continue;

    sessions.push({
      sessionId: session.happySessionId,
      agent,
      active: true,
      thinking: session.runtime?.thinking === true,
      hasOpenToolCall: session.runtime?.hasOpenToolCall === true,
      pendingUserInput: session.runtime?.pendingUserInput === true,
      ...(session.runtime?.lastUserInteractionAt !== undefined
        ? { lastUserInteractionAt: session.runtime.lastUserInteractionAt }
        : {}),
      ...(session.runtime?.mode !== undefined ? { mode: session.runtime.mode } : {}),
      lastActiveAt: resolveSessionLastActiveAt(session, input.sessionStartTimes, now),
    });
  }

  return {
    machineId: input.machineId,
    ...(input.idleAfterMs !== undefined ? { idleAfterMs: input.idleAfterMs } : {}),
    ...(input.presenceStaleMs !== undefined ? { presenceStaleMs: input.presenceStaleMs } : {}),
    sessions,
  };
}

export async function postDaemonSessionIdleReaperCandidates(input: PostCandidatesInput): Promise<DaemonSessionIdleReaperResponse> {
  const response = await axios.post<DaemonSessionIdleReaperResponse>(
    `${input.serverUrl.replace(/\/+$/, '')}/api/daemon/session-idle-reaper/candidates`,
    input.request,
    {
      headers: {
        Authorization: `Bearer ${input.credentialsToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    },
  );

  return {
    checkedAt: typeof response.data.checkedAt === 'number' ? response.data.checkedAt : Date.now(),
    candidates: Array.isArray(response.data.candidates) ? response.data.candidates : [],
  };
}

export async function runDaemonSessionIdleReaperTick(
  input: RunDaemonSessionIdleReaperTickInput,
): Promise<DaemonSessionIdleReaperTickResult> {
  const request = buildDaemonSessionIdleReaperRequest(input);
  const result: DaemonSessionIdleReaperTickResult = {
    requestedSessions: request.sessions.length,
    candidateSessions: 0,
    stoppedSessions: 0,
    skippedActiveSessions: 0,
    noopSessions: 0,
  };
  if (request.sessions.length === 0) return result;

  let response: DaemonSessionIdleReaperResponse;
  try {
    response = await (input.postCandidates ?? postDaemonSessionIdleReaperCandidates)({
      serverUrl: input.serverUrl,
      credentialsToken: input.credentialsToken,
      request,
    });
  } catch (error) {
    input.logDebug?.(`[session-idle-reaper] candidate request failed: ${formatError(error)}`);
    return result;
  }

  result.candidateSessions = response.candidates.length;
  for (const candidate of response.candidates) {
    // Even though the server already excludes busy sessions, the daemon
    // re-validates locally (if-idle) because it is the only component that sees
    // real user activity for the child process it owns.
    const stopResult = input.stopSession(candidate.sessionId, {
      source: 'session-idle-reaper',
      mode: 'if-idle',
    });
    if (stopResult.stopped) {
      result.stoppedSessions += 1;
    } else if (stopResult.reason === 'active') {
      result.skippedActiveSessions += 1;
    } else {
      result.noopSessions += 1;
    }
  }

  if (result.candidateSessions > 0) {
    input.logDebug?.(
      `[session-idle-reaper] candidates=${result.candidateSessions} stopped=${result.stoppedSessions} skippedActive=${result.skippedActiveSessions} noop=${result.noopSessions}`,
    );
  }

  return result;
}

function resolveStoppableAgent(session: TrackedSession): 'claude' | 'codex' | null {
  const flavor = session.happySessionMetadataFromLocalWebhook?.flavor;
  if (flavor === 'claude' || flavor === 'codex') return flavor;
  if (!flavor) return 'claude';
  return null;
}

function resolveSessionLastActiveAt(
  session: TrackedSession,
  sessionStartTimes: ReadonlyMap<number, number>,
  now: number,
): number {
  const activityTimes = [
    sessionStartTimes.get(session.pid),
    session.runtime?.updatedAt,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return activityTimes.length > 0 ? Math.max(...activityTimes) : now;
}

function parseOptionalMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.toLowerCase() ?? '');
}

function isExplicitlyFalse(value: string | undefined): boolean {
  return ['0', 'false', 'no'].includes(value?.toLowerCase() ?? '');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

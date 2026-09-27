import axios from 'axios';

import type { SessionRuntimeState, TrackedSession } from './types';

/** Idle cut: a session with no real user activity for this long is cleaned up
 *  (SIGTERM — the session stays resumable). */
export const DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS = 24 * 60 * 60 * 1000;
/** A conversation that reached a clean turn-end and sat idle this long is
 *  reclaimed early (SIGTERM — resumable). Conversations that launched a
 *  background job are exempt and fall back to the absolute idle cut above. */
export const DEFAULT_SESSION_TURN_END_REAPER_MS = 60 * 60 * 1000;
/** A session the user opened but never interacted with (no prompt ever started
 *  a turn, no turn ever completed) is reclaimed after this long. Neither the
 *  turn-end reap (needs a turn-end) nor the zombie sweep (needs runtime silence)
 *  catches it, so without this it would sit until the multi-day absolute cut. */
export const DEFAULT_SESSION_EMPTY_REAPER_MS = 15 * 60 * 1000;
export const DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_IDLE_STOP_HARD_CAP_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_IDLE_STOP_PRESENCE_STALE_MS = 5 * 60 * 1000;
/** How long a freshly adopted session is shielded from policy stops. An adopted
 *  orphan keeps its real age, so it can qualify for the empty/idle reaps on the
 *  first tick after adoption; one report cycle (≤30s) plus margin lets it prove
 *  what it is first. Long enough to cover a heartbeat tick (60s), short enough
 *  that a genuine leak isn't held for long. */
export const DEFAULT_ADOPTION_GRACE_MS = 2 * 60 * 1000;
/** Local guard floor: no policy stop may kill a session the user touched
 *  within this window, regardless of process age. */
export const DEFAULT_IDLE_STOP_RECENT_INTERACTION_MS = 30 * 60 * 1000;
/** Max sessions SIGTERM'd by a single reaper tick. A fixed batch of stopped
 *  sessions is always resumable, but stopping hundreds at once (e.g. after a
 *  guard bug is fixed and a large backlog is suddenly eligible) is a surprise
 *  worth spreading across ticks instead. Remaining candidates are picked up
 *  again on the next tick. */
export const DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX = 10;

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
  /** Last time the agent finished a turn and went idle — lets the server reap a
   *  done conversation early (turnEndReaperMs) instead of at the absolute cut. */
  lastTurnEndAt?: number;
  /** Conversation launched a background job → exempt from the turn-end reap. */
  launchedBackgroundJob?: boolean;
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
  /** Reap a turn-ended, non-background conversation after this much idle time. */
  turnEndReaperMs?: number;
};

type DaemonSessionIdleReaperCandidate = {
  sessionId: string;
  /** Server-side display value; null for sessions without a project mapping
   *  (personal chats) that a trial budget stop still targets. */
  projectId: string | null;
  machineId: string;
  lastActiveAt: number;
  idleMs: number;
  /** Why the server selected this session. Absent from servers that predate
   *  the turn-end reap — treated as the absolute-idle-cut for logging. */
  reason?: 'absolute-idle-cut' | 'turn-end' | 'trial-budget-exhausted';
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
  turnEndReaperMs?: number;
  /** Max sessions to stop this tick; extra candidates are deferred to the next
   *  tick. Defaults to DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX. */
  batchMax?: number;
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
  /** Candidates left unprocessed this tick because batchMax was reached. */
  deferredSessions: number;
};

/**
 * 'force' stops unconditionally (user-initiated), 'if-idle' runs the full local
 * idle guard (background cleanup), and 'if-not-busy' runs only the hard blocks
 * — used by aplus-dev-studio's trial budget stop (specs/trial-auto-onboarding-budget
 * D5), where a session must end as soon as its turn finishes even though the
 * user interacted seconds ago. Soft guards (recent interaction, minimum age,
 * local mode, stale runtime) exist to protect work the user may return to; a
 * budget-exhausted trial session has no such future — the shared credential
 * must leave the process.
 */
export type StopSessionMode = 'force' | 'if-idle' | 'if-not-busy';

/** Candidate reason that must bypass the soft idle guards. */
export const TRIAL_BUDGET_EXHAUSTED_REASON = 'trial-budget-exhausted';

export function restoreSessionStartTimes(input: {
  trackedSessions: readonly Pick<TrackedSession, 'pid'>[];
  persistedSessions: readonly { pid: number; startedAt: number }[];
  now: number;
}): Map<number, number> {
  const persistedByPid = new Map(input.persistedSessions.map((session) => [session.pid, session.startedAt]));
  return new Map(input.trackedSessions.map((session) => [
    session.pid,
    persistedByPid.get(session.pid) ?? input.now,
  ]));
}

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
  | { stopped: false; reason: 'active'; guard: string; activity: IdleStopGuardActivity }
  /**
   * A managed generation. A signal to the tracked pid would stop neither the
   * generation's tools nor the broker that grants them, and would prove
   * nothing either way, so the stop goes to the supervisor instead and this
   * path reports that it did not do it itself.
   */
  | { stopped: false; reason: 'managed-generation'; detail: string }
  | { stopped: false; reason: 'standalone-drain'; detail: string }
  | { stopped: false; reason: 'standalone-unowned'; detail: string }
  | { stopped: false; reason: 'standalone-blocked'; detail: string };

const POLICY_STOP_SOURCES = new Set(['project-session-idle-stop', 'session-idle-reaper', 'session-zombie-sweep', 'session-empty-reaper']);

/** True when a stop source is a background cleanup policy rather than a user action. */
export function isPolicyStopSource(source: unknown): boolean {
  if (typeof source !== 'string') return false;
  const normalized = source.toLowerCase();
  return POLICY_STOP_SOURCES.has(normalized) || normalized.includes('idle');
}

export function resolveStopSessionMode(context?: StopSessionContext): StopSessionMode {
  if (context?.mode === 'force' || context?.mode === 'if-idle' || context?.mode === 'if-not-busy') {
    return context.mode;
  }
  if (context?.reason === TRIAL_BUDGET_EXHAUSTED_REASON) return 'if-not-busy';
  return isPolicyStopSource(context?.source) ? 'if-idle' : 'force';
}

/**
 * Hard blocks only: the session is stopped unless it is mid-turn. Absent runtime
 * state denies, because "no report yet" is not evidence that nothing is running.
 */
export function evaluateBusyOnlyStopGuard(input: {
  runtime?: SessionRuntimeState;
}): IdleStopGuardDecision {
  const { runtime } = input;
  const activity: IdleStopGuardActivity = {
    thinking: runtime?.thinking === true,
    hasOpenToolCall: runtime?.hasOpenToolCall === true,
    pendingUserInput: runtime?.pendingUserInput === true,
    ...(runtime?.lastUserInteractionAt !== undefined ? { lastUserInteractionAt: runtime.lastUserInteractionAt } : {}),
    ...(runtime?.mode !== undefined ? { mode: runtime.mode } : {}),
    ...(runtime?.updatedAt !== undefined ? { runtimeUpdatedAt: runtime.updatedAt } : {}),
  };
  const deny = (guard: string): IdleStopGuardDecision => ({ allow: false, guard, activity });
  if (runtime === undefined) return deny('unknown-runtime');
  if (activity.thinking) return deny('thinking');
  if (activity.hasOpenToolCall) return deny('open-tool-call');
  if (activity.pendingUserInput) return deny('pending-user-input');
  return { allow: true };
}

export type IdleStopGuardConfig = {
  /** Sessions the user touched within this window are never policy-stopped —
   *  a short safety floor (default 30m) so a race can't kill a session the
   *  user just interacted with, independent of the 24h idle cut. */
  recentInteractionMs: number;
  minSessionAgeMs: number;
  hardCapMs: number;
  presenceStaleMs: number;
  protectLocalSessions: boolean;
  /** Shield window applied after a session is adopted from a previous daemon. */
  adoptionGraceMs: number;
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
    recentInteractionMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_RECENT_INTERACTION_MS)
      ?? DEFAULT_IDLE_STOP_RECENT_INTERACTION_MS,
    minSessionAgeMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_MIN_AGE_MS)
      ?? DEFAULT_IDLE_STOP_MIN_SESSION_AGE_MS,
    hardCapMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_HARD_CAP_MS)
      ?? DEFAULT_IDLE_STOP_HARD_CAP_MS,
    presenceStaleMs: parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_PRESENCE_STALE_MS)
      ?? DEFAULT_IDLE_STOP_PRESENCE_STALE_MS,
    protectLocalSessions: !isExplicitlyFalse(env.HAPPY_DAEMON_SESSION_IDLE_PROTECT_LOCAL),
    adoptionGraceMs: parseOptionalMs(env.HAPPY_DAEMON_ADOPTION_GRACE_MS)
      ?? DEFAULT_ADOPTION_GRACE_MS,
  };
}

/**
 * Decide whether a policy-initiated stop is allowed for a session, based purely
 * on the session's locally-observed runtime state. The daemon is the only
 * component that owns the child process and sees cross-surface activity
 * (terminal, mobile, app), so it has the final word over cleanup policies.
 *
 * Hard blocks (thinking / open tool call / pending user input) always deny,
 * and recent user interaction always denies — no cleanup policy may kill a
 * session the user touched within `recentInteractionMs`, regardless of
 * process age.
 *
 * The zombie escape hatch is measured by runtime-report silence, not process
 * age: live sessions report on every keepalive (≤30s), so `hardCapMs` without
 * a report means the runtime is dead even though the PID is alive. A session
 * that has never reported to this daemon measures silence from the moment this
 * daemon could first have heard it (the later of session start and daemon
 * start), which gives recovered sessions a full report window after a daemon
 * restart instead of being reaped on the first tick.
 */
export function evaluateIdleStopGuard(input: {
  runtime?: SessionRuntimeState;
  sessionStartedAt?: number;
  /** When this daemon process started — lower bound for how long a session
   *  that never reported could have been silent toward this daemon. */
  daemonStartedAt?: number;
  /** Who spawned this session. Daemon-spawned sessions are always launched
   *  with --happy-starting-mode remote (runClaude.ts refuses daemon+local at
   *  spawn time), so a 'local' report from one is overwhelmingly a client-side
   *  reporting bug rather than a terminal the user is sitting at, and must not
   *  trigger the local-session guard.
   *
   *  Tradeoff: a user CAN reach a genuine local mode on a daemon-spawned
   *  (e.g. tmux) session by triggering the 'switch' RPC, and that case loses
   *  local protection here. It is still covered by the hard blocks above
   *  (thinking / open tool call / pending user input) and by the
   *  recent-user-interaction floor, and any stop is a resumable SIGTERM.
   *
   *  Required (not optional) so a future edit that drops the argument at the
   *  call site fails to compile, instead of silently reverting to treating
   *  every daemon-spawned session as protectable local state. */
  startedBy: TrackedSession['startedBy'];
  /** When this daemon adopted the session from a previous daemon, if it did. */
  adoptedAt?: number;
  now: number;
  config: IdleStopGuardConfig;
}): IdleStopGuardDecision {
  const { runtime, sessionStartedAt, daemonStartedAt, startedBy, adoptedAt, now, config } = input;

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

  if (activity.lastUserInteractionAt !== undefined
    && now - activity.lastUserInteractionAt < config.recentInteractionMs) {
    return deny('recent-user-interaction');
  }

  // Must sit ahead of the hard-cap allow below: an adopted orphan carries its
  // real age and its pre-adoption silence, so without this a session recovered
  // from a dead daemon would be reclaimed on the tick right after adoption —
  // the recovery would look identical to the leak it was meant to fix.
  if (adoptedAt !== undefined && now - adoptedAt < config.adoptionGraceMs) {
    return deny('adoption-grace');
  }

  const { sessionAgeMs } = activity;

  // Zombie escape hatch: hardCapMs of runtime-report silence with no busy
  // signal means the runtime is dead — allow cleanup even when the soft
  // protections below would otherwise apply. Silence for a session that never
  // reported starts at the later of session start and daemon start.
  const silenceSinceAt = runtime?.updatedAt
    ?? maxDefined(sessionStartedAt, daemonStartedAt);
  if (silenceSinceAt !== undefined && now - silenceSinceAt >= config.hardCapMs) {
    return { allow: true };
  }

  if (sessionAgeMs !== undefined && sessionAgeMs < config.minSessionAgeMs) {
    return deny('min-session-age');
  }
  if (config.protectLocalSessions && activity.mode === 'local' && startedBy !== 'daemon') {
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
  /** undefined when the turn-end reap is disabled (env set to 0). */
  turnEndReaperMs?: number;
  batchMax: number;
};

export function readDaemonSessionIdleReaperConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { managedRuntimeActive: boolean } = { managedRuntimeActive: false },
): DaemonSessionIdleReaperConfig {
  const idleAfterMs = parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_AFTER_MS);
  const presenceStaleMs = parseOptionalMs(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_PRESENCE_STALE_MS);
  // Turn-end reap: default 1h; env override; explicit 0 disables it (absolute
  // cut still applies). A machine that runs long unattended background jobs can
  // lengthen or disable this knob.
  const turnEndRaw = parseOptionalMs(env.HAPPY_DAEMON_SESSION_TURN_END_REAPER_MS);
  const turnEndReaperMs = turnEndRaw === undefined
    ? DEFAULT_SESSION_TURN_END_REAPER_MS
    : (turnEndRaw > 0 ? turnEndRaw : undefined);
  const batchMax = parseOptionalCount(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_BATCH_MAX);
  return {
    // The candidates route authenticates an *account*. A managed runtime's
    // bearer names a machine grant, so the round-trip would be refused on
    // every tick; and the parent already owns that runtime's lifecycle through
    // leases. Off, not "on and failing" — the same rule as script automations
    // and the BYOS offline receiver.
    disabled: runtime.managedRuntimeActive || isTruthy(env.HAPPY_DAEMON_SESSION_IDLE_REAPER_DISABLED),
    idleAfterMs: idleAfterMs ?? DEFAULT_DAEMON_SESSION_IDLE_REAPER_AFTER_MS,
    ...(presenceStaleMs !== undefined ? { presenceStaleMs } : {}),
    ...(turnEndReaperMs !== undefined ? { turnEndReaperMs } : {}),
    batchMax: batchMax ?? DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX,
  };
}

export function buildDaemonSessionIdleReaperRequest(input: {
  machineId: string;
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  now?: number;
  idleAfterMs?: number;
  presenceStaleMs?: number;
  turnEndReaperMs?: number;
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
      ...(session.runtime?.lastTurnEndAt !== undefined
        ? { lastTurnEndAt: session.runtime.lastTurnEndAt }
        : {}),
      ...(session.runtime?.launchedBackgroundJob ? { launchedBackgroundJob: true } : {}),
      ...(session.runtime?.mode !== undefined ? { mode: session.runtime.mode } : {}),
      lastActiveAt: resolveSessionLastActiveAt(session, input.sessionStartTimes, now),
    });
  }

  return {
    machineId: input.machineId,
    ...(input.idleAfterMs !== undefined ? { idleAfterMs: input.idleAfterMs } : {}),
    ...(input.presenceStaleMs !== undefined ? { presenceStaleMs: input.presenceStaleMs } : {}),
    ...(input.turnEndReaperMs !== undefined ? { turnEndReaperMs: input.turnEndReaperMs } : {}),
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
    deferredSessions: 0,
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
  const batchMax = input.batchMax ?? DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX;
  let turnEndStopped = 0;
  let processed = 0;
  for (const candidate of response.candidates) {
    // The cap counts actual stops, not attempts: the server cannot see local
    // guard denials, so it returns the same refused candidates every tick.
    // Counting attempts would let a block of permanently-refused candidates
    // starve every reapable session behind them.
    if (result.stoppedSessions >= batchMax) break;
    processed += 1;
    const reason = candidate.reason ?? 'absolute-idle-cut';
    // Even though the server already excludes busy sessions, the daemon
    // re-validates locally (if-idle) because it is the only component that sees
    // real user activity for the child process it owns.
    // 예산 소진 후보는 소프트 가드를 우회한다(하드 블록은 유지) — 방금 턴을 마친
    // 세션이 바로 대상이며, 그 세션이 공용 키를 들고 있기 때문이다.
    const stopResult = input.stopSession(candidate.sessionId, {
      source: 'session-idle-reaper',
      reason,
      mode: reason === TRIAL_BUDGET_EXHAUSTED_REASON ? 'if-not-busy' : 'if-idle',
    });
    if (stopResult.stopped) {
      result.stoppedSessions += 1;
      if (reason === 'turn-end') turnEndStopped += 1;
    } else if (stopResult.reason === 'active') {
      result.skippedActiveSessions += 1;
    } else {
      result.noopSessions += 1;
    }
  }
  result.deferredSessions = response.candidates.length - processed;

  if (result.candidateSessions > 0) {
    input.logDebug?.(
      `[session-idle-reaper] candidates=${result.candidateSessions} stopped=${result.stoppedSessions} (turnEnd=${turnEndStopped}) skippedActive=${result.skippedActiveSessions} noop=${result.noopSessions} deferred=${result.deferredSessions}`,
    );
  }

  return result;
}

/**
 * Daemon-local zombie sweep, independent of the server candidate flow: a live
 * session reports runtime on every keepalive (≤30s), so `silenceMs` (default
 * the idle-stop hard cap) without any report means the runtime is dead even
 * though the PID is alive. Sessions that never reported measure silence from
 * the later of session start and daemon start, giving recovered sessions a
 * full report window after a daemon restart. Stops are if-idle, so the guard
 * re-validates each one.
 *
 * Deliberately has no per-sweep batch cap, unlike the idle and empty reapers:
 * every session it stops has already been silent for the hard cap, so it is
 * reclaiming dead runtimes rather than live conversations. There is no live
 * session to surprise by stopping many at once.
 */
export function sweepZombieSessions(input: {
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  daemonStartedAt: number;
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  now?: number;
  silenceMs?: number;
  logDebug?: (message: string) => void;
}): number {
  const now = input.now ?? Date.now();
  const silenceMs = input.silenceMs ?? DEFAULT_IDLE_STOP_HARD_CAP_MS;
  let stopped = 0;

  for (const session of input.trackedSessions) {
    if (!session.happySessionId) continue;
    const lastEvidenceAt = session.runtime?.updatedAt
      ?? maxDefined(input.sessionStartTimes.get(session.pid), input.daemonStartedAt);
    if (lastEvidenceAt === undefined || now - lastEvidenceAt < silenceMs) continue;

    const stopResult = input.stopSession(session.happySessionId, {
      source: 'session-zombie-sweep',
      reason: 'runtime-silent',
      mode: 'if-idle',
    });
    if (stopResult.stopped) {
      stopped += 1;
      input.logDebug?.(
        `[session-zombie-sweep] stopped ${session.happySessionId} (no runtime report for ${Math.round((now - lastEvidenceAt) / 60_000)}m)`,
      );
    }
  }

  return stopped;
}

/**
 * Read the empty-session reap window from env. Returns the default (15m) when
 * unset, the override when a positive value is given, and `undefined` (feature
 * off) when explicitly set to 0.
 */
export function readEmptySessionReaperMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = parseOptionalMs(env.HAPPY_DAEMON_SESSION_EMPTY_REAPER_MS);
  if (raw === undefined) return DEFAULT_SESSION_EMPTY_REAPER_MS;
  return raw > 0 ? raw : undefined;
}

/**
 * Daemon-local reap of never-used sessions: a session the user opened (project
 * spawned) but never interacted with — no prompt ever started a turn
 * (`lastUserInteractionAt` absent), no turn ever completed (`lastTurnEndAt`
 * absent), and no background job launched. Such a session reports a live-but-idle
 * runtime forever, so neither the turn-end reap (needs `lastTurnEndAt`) nor the
 * zombie sweep (needs runtime silence) reclaims it — without this it sits until
 * the multi-day absolute idle cut. A missing runtime is left alone (spawn in
 * flight / recovered) and handled by the guard's stale-runtime protection. Stops
 * are if-idle, so `evaluateIdleStopGuard` re-validates each one (min session age,
 * local-mode protection, freshly-busy).
 */
export function sweepEmptySessions(input: {
  trackedSessions: readonly TrackedSession[];
  sessionStartTimes: ReadonlyMap<number, number>;
  stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
  now?: number;
  emptyReaperMs?: number;
  /** Max sessions to stop per sweep; the rest are picked up on the next tick.
   *  Shares the idle reaper's cap so a tick cannot exceed it on either path. */
  batchMax?: number;
  logDebug?: (message: string) => void;
}): number {
  const now = input.now ?? Date.now();
  const emptyReaperMs = input.emptyReaperMs ?? DEFAULT_SESSION_EMPTY_REAPER_MS;
  const batchMax = input.batchMax ?? DEFAULT_SESSION_IDLE_REAPER_BATCH_MAX;
  let stopped = 0;
  let deferred = 0;

  for (const session of input.trackedSessions) {
    if (!session.happySessionId) continue;
    if (!resolveStoppableAgent(session)) continue;

    const runtime = session.runtime;
    if (!runtime) continue;
    if (runtime.thinking || runtime.hasOpenToolCall || runtime.pendingUserInput) continue;
    if (runtime.lastUserInteractionAt !== undefined) continue;
    if (runtime.lastTurnEndAt !== undefined) continue;
    if (runtime.launchedBackgroundJob) continue;

    const startedAt = input.sessionStartTimes.get(session.pid);
    if (startedAt === undefined || now - startedAt < emptyReaperMs) continue;

    // Cap actual stops per sweep, for the same reason the idle reaper does:
    // this sweep runs on every tick (and before the idle reaper), so a backlog
    // of never-used sessions — exactly what the local-session guard used to
    // protect — would otherwise be SIGTERM'd all at once on the first tick
    // after that guard is fixed.
    if (stopped >= batchMax) {
      deferred += 1;
      continue;
    }

    const stopResult = input.stopSession(session.happySessionId, {
      source: 'session-empty-reaper',
      reason: 'never-used',
      mode: 'if-idle',
    });
    if (stopResult.stopped) {
      stopped += 1;
      input.logDebug?.(
        `[session-empty-reaper] stopped ${session.happySessionId} (never used, alive ${Math.round((now - startedAt) / 60_000)}m)`,
      );
    }
  }

  if (deferred > 0) {
    input.logDebug?.(`[session-empty-reaper] deferred=${deferred} (batchMax=${batchMax})`);
  }

  return stopped;
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
  const sessionStartedAt = sessionStartTimes.get(session.pid);
  return typeof sessionStartedAt === 'number' && Number.isFinite(sessionStartedAt)
    ? sessionStartedAt
    : now;
}

function maxDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => typeof v === 'number');
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function parseOptionalMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Parse a positive whole count. Zero/negative/garbage return undefined so the
 *  caller falls back to its default — a cap of 0 would silently turn the whole
 *  policy into a no-op, which is what the *_DISABLED knobs are for. */
function parseOptionalCount(value: string | undefined): number | undefined {
  const parsed = parseOptionalMs(value);
  if (parsed === undefined) return undefined;
  const count = Math.floor(parsed);
  return count >= 1 ? count : undefined;
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

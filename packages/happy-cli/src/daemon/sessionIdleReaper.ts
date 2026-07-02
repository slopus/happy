import axios from 'axios';

import type { TrackedSession } from './types';

type DaemonSessionIdleReaperObservedSession = {
  sessionId: string;
  agent: 'claude' | 'codex';
  active: true;
  thinking: false;
  hasOpenToolCall: false;
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
  stopSession: (sessionId: string) => boolean;
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
  noopSessions: number;
};

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
    ...(idleAfterMs !== undefined ? { idleAfterMs } : {}),
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
      thinking: false,
      hasOpenToolCall: false,
      lastActiveAt: input.sessionStartTimes.get(session.pid) ?? now,
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
    const stopped = input.stopSession(candidate.sessionId);
    if (stopped) {
      result.stoppedSessions += 1;
    } else {
      result.noopSessions += 1;
    }
  }

  if (result.candidateSessions > 0) {
    input.logDebug?.(
      `[session-idle-reaper] candidates=${result.candidateSessions} stopped=${result.stoppedSessions} noop=${result.noopSessions}`,
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

function parseOptionalMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.toLowerCase() ?? '');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

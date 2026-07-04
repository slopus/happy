import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { TrackedSession } from './types';

export const DEFAULT_SESSION_START_SOFT_TIMEOUT_MS = 15_000;
export const DEFAULT_SESSION_START_TIMEOUT_MS = 60_000;

function readPositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function readSessionStartTimeoutConfig(env: NodeJS.ProcessEnv = process.env): {
  softTimeoutMs: number;
  finalTimeoutMs: number;
} {
  const softTimeoutMs = readPositiveInteger(env.SESSION_START_SOFT_TIMEOUT_MS)
    ?? DEFAULT_SESSION_START_SOFT_TIMEOUT_MS;
  const requestedFinalTimeoutMs = readPositiveInteger(env.SESSION_START_TIMEOUT_MS)
    ?? DEFAULT_SESSION_START_TIMEOUT_MS;
  const finalTimeoutMs = Math.max(requestedFinalTimeoutMs, softTimeoutMs + 1);
  return { softTimeoutMs, finalTimeoutMs };
}

export function waitForSessionWebhook({
  pid,
  pidToAwaiter,
  label = '',
  logger,
  timeouts = readSessionStartTimeoutConfig(),
}: {
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  label?: string;
  logger: { debug: (message: string, ...args: unknown[]) => void };
  timeouts?: { softTimeoutMs: number; finalTimeoutMs: number };
}): Promise<SpawnSessionResult> {
  const suffix = label ? ` ${label}` : '';
  logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}${suffix}`);

  return new Promise((resolve) => {
    let delayed = false;
    let settled = false;

    const softTimeout = setTimeout(() => {
      delayed = true;
      logger.debug(`[DAEMON RUN] Session webhook still pending for PID ${pid}${suffix} after ${timeouts.softTimeoutMs}ms`);
    }, timeouts.softTimeoutMs);

    const finalTimeout = setTimeout(() => {
      settled = true;
      pidToAwaiter.delete(pid);
      logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}${suffix} after ${timeouts.finalTimeoutMs}ms`);
      resolve({
        type: 'error',
        errorMessage: `Session webhook timeout for PID ${pid}${suffix}`
      });
    }, timeouts.finalTimeoutMs);

    pidToAwaiter.set(pid, (completedSession) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimeout);
      clearTimeout(finalTimeout);
      if (delayed) {
        logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} spawned after delayed webhook for PID ${pid}${suffix}`);
      }
      logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook${suffix}`);
      resolve({
        type: 'success',
        sessionId: completedSession.happySessionId!
      });
    });
  });
}

import { TrackedSession } from './types';

export type IsPidAlive = (pid: number) => boolean;

export const defaultIsPidAlive: IsPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
};

export function pruneStaleTrackedSessions(
  pidToTrackedSession: Map<number, TrackedSession>,
  isPidAlive: IsPidAlive = defaultIsPidAlive
): number {
  let removed = 0;

  for (const [pid] of pidToTrackedSession.entries()) {
    if (isPidAlive(pid)) continue;
    pidToTrackedSession.delete(pid);
    removed += 1;
  }

  return removed;
}

import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';

// IMPORTANT: keep this strict. A false positive here could cause us to adopt/kill an unrelated process.
export const ALLOWED_HAPPY_SESSION_PROCESS_TYPES = new Set([
  'daemon-spawned-session',
  'user-session',
  'dev-daemon-spawned',
  'dev-session',
]);

export async function isPidSafeHappySessionProcess(params: {
  pid: number;
  expectedProcessCommandHash?: string;
}): Promise<boolean> {
  const proc = await findHappyProcessByPid(params.pid);
  if (!proc || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(proc.type)) return false;

  if (params.expectedProcessCommandHash) {
    return hashProcessCommand(proc.command) === params.expectedProcessCommandHash;
  }

  return true;
}

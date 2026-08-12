import type { TrackedSession } from './types';

/**
 * Removes daemon sessions whose tmux windows have naturally closed. A pane PID
 * alone is not sufficient here: it can be reused after tmux removes the
 * window, leaving the daemon with a permanently occupied capacity slot.
 */
export async function reapClosedTmuxSessions(options: {
  sessions: Map<number, TrackedSession>;
  isWindowAlive: (sessionIdentifier: string) => Promise<boolean | undefined>;
  onSessionExited: (pid: number) => void;
}): Promise<number> {
  let reaped = 0;

  for (const [pid, session] of options.sessions.entries()) {
    if (!session.tmuxSessionId) continue;

    let alive: boolean | undefined;
    try {
      alive = await options.isWindowAlive(session.tmuxSessionId);
    } catch {
      // A transient tmux failure must not make the daemon forget a live pane.
      continue;
    }
    // Leave the session intact when tmux cannot be queried. It is safer to
    // temporarily retain capacity than to lose track of a still-running pane.
    if (alive !== false || options.sessions.get(pid) !== session) continue;

    options.onSessionExited(pid);
    reaped += 1;
  }

  return reaped;
}

/**
 * Thinking-state (is-it-working) tracking for local mode.
 *
 * Background: Happy used to infer busy/idle by patching `global.fetch` inside
 * claude_local_launcher.cjs. Since Claude Code 2.x ships as a native binary,
 * the launcher is merely its parent node process, and an in-process fetch
 * patch cannot cross that process boundary. Local-mode `thinking` is therefore
 * always false: the phone shows the session as online but never as working.
 *
 * Instead we read the session status file Claude Code maintains itself:
 *   ~/.claude/sessions/<pid>.json → { pid, sessionId, status, statusUpdatedAt }
 * matched by sessionId rather than pid, since `claude` is a child of the
 * launcher and Happy never learns its pid.
 *
 * `status` is a closed set of four values in 2.1.220:
 *   busy     working; flips within ~60ms of prompt submission
 *   idle     not working
 *   waiting  blocked on the user, so not working. The same file carries a
 *            `waitingFor` discriminant, which reads `input needed` while an
 *            AskUserQuestion prompt is open. In the transcript every `waiting`
 *            interval opens with a `tool_use: AskUserQuestion` whose
 *            `stop_reason` is already `tool_use` (so the API call had already
 *            completed) and ends within one poll of the user's answer landing
 *            as a `tool_result`.
 *   shell    observed once, holding for 4m46s before returning to `busy` on
 *            its own. Its meaning is still unverified, so it rides the
 *            unknown-value default below. If it turns out to mark a tool
 *            running, the spinner is absent for that span — today's behaviour
 *            rather than a new failure.
 *
 * `claude agents --json` exposes `status` and `waitingFor` as public output,
 * which is what pins those semantics down. It is a projection of this file
 * rather than the file itself, though: it drops `statusUpdatedAt`, which the
 * arbitration below needs. So we read the file and treat its exact shape as
 * private — see the degradation note on the unknown-value default.
 *
 * Why not the Stop hook: on ESC-interrupt, Stop does not fire at all, while
 * `status` still returns to idle correctly. Driving this from hooks would
 * leave `thinking` stuck at true after every interrupt, so the phone would
 * show "working forever" — strictly worse than today's "idle forever".
 *
 * One rule runs through this whole module: **any uncertainty must resolve to
 * false.** Missing a spinner is acceptable; getting stuck showing "working" is
 * not, because that is worse than the bug being fixed. The deliberately
 * conservative choices below all follow from it: unknown status is false, a
 * session change resets to false, a persistently unreadable status file
 * resets to false, and a file from a live process beats a newer timestamp.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@/ui/logger";

/** The only `status` value that counts as working. */
const BUSY_STATUS = "busy";

const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * How many consecutive polls may fail to find a status file before we declare
 * "not working". A few polls of grace, because the file may be mid atomic
 * replace (a rename can briefly leave nothing to find) and a single failed
 * read should not make the state flicker. But the grace cannot be unbounded,
 * or a changed session id would pin `thinking` at true forever.
 */
const MISSING_FILE_GRACE_POLLS = 3;

function claudeSessionsDir(): string {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "sessions");
}

/** Is the process still alive? EPERM means it exists but is not ours, which also counts. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** Liveness precedence: alive > undeterminable > dead. Ties broken by timestamp. */
function livenessRank(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return 1; // no usable pid, so liveness cannot be determined
  }
  return isProcessAlive(pid) ? 2 : 0;
}

/**
 * Find the `status` of the session file matching `sessionId` in
 * ~/.claude/sessions. Returns null when there is none (not written yet, or
 * already cleaned up).
 *
 * Session files are named by pid and are not removed when the process exits.
 * If `claude` is killed mid-turn, the leftover file stays at status=busy
 * forever; when that same sessionId is later resumed under a new pid, two
 * files in the directory match it.
 *
 * Taking the largest `statusUpdatedAt` is not enough to rule the stale one
 * out, because a newer timestamp does not imply a live process. The real
 * counterexample: a live process drops to idle at T2 and its timestamp stops
 * advancing, while another process flips to busy at T3 > T2 and is then
 * SIGKILLed — the leftover busy@T3 would win forever and the phone would show
 * "working" permanently. So rank by process liveness first, timestamp second.
 */
async function readStatusForSession(sessionId: string): Promise<string | null> {
  const dir = claudeSessionsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const candidates = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const raw = await readFile(join(dir, name), "utf-8");
          const parsed = JSON.parse(raw) as {
            pid?: unknown;
            sessionId?: unknown;
            status?: unknown;
            statusUpdatedAt?: unknown;
            updatedAt?: unknown;
          };
          if (
            parsed.sessionId !== sessionId ||
            typeof parsed.status !== "string"
          ) {
            return null;
          }
          // Number.isFinite rejects Infinity/NaN: JSON.parse turns 1e999 into
          // Infinity while typeof stays "number", and comparing it directly
          // would pin the selection on the first corrupt file forever, since
          // Infinity > Infinity is false.
          const at = Number.isFinite(parsed.statusUpdatedAt)
            ? (parsed.statusUpdatedAt as number)
            : Number.isFinite(parsed.updatedAt)
              ? (parsed.updatedAt as number)
              : -Infinity;
          return {
            status: parsed.status,
            at,
            liveness: livenessRank(parsed.pid),
          };
        } catch {
          // Half-written file or invalid JSON: skip it, try again next poll.
          return null;
        }
      }),
  );

  let best: { status: string; at: number; liveness: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (
      best === null ||
      candidate.liveness > best.liveness ||
      (candidate.liveness === best.liveness && candidate.at > best.at)
    ) {
      best = candidate;
    }
  }
  return best?.status ?? null;
}

export interface ClaudeStatusWatcherOptions {
  /**
   * Current Claude session id. May be unknown at startup (we are waiting on
   * the SessionStart hook); returning null counts as not working.
   */
  getSessionId: () => string | null;
  /** Called only when the state actually changes. */
  onThinkingChange: (thinking: boolean) => void;
  pollIntervalMs?: number;
}

/**
 * Poll Claude Code's session status file, mapping busy/anything-else onto
 * thinking true/false. Returns a stop function, which forces thinking back to
 * false so shutdown cannot leave the state stuck at "working".
 */
export function startClaudeStatusWatcher(
  opts: ClaudeStatusWatcherOptions,
): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let lastThinking = false;
  let polling = false;
  let lastSessionId: string | null = null;
  let missingPolls = 0;

  // Single exit point: report only on a real change, so every "reset to false"
  // path can reuse it.
  const applyThinking = (thinking: boolean, reason: string) => {
    if (thinking === lastThinking) {
      return;
    }
    lastThinking = thinking;
    logger.debug(`[ClaudeStatusWatcher] ${reason} → thinking=${thinking}`);
    opts.onThinkingChange(thinking);
  };

  const tick = async () => {
    // Skip if the previous poll is still running, so a slow disk cannot pile
    // them up.
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      const sessionId = opts.getSessionId();

      // The session changed (SessionStart hook handed us a new id) or was
      // cleared by /clear. The old session's thinking must not carry over,
      // or a new session with no matching file would stay stuck at true.
      if (sessionId !== lastSessionId) {
        lastSessionId = sessionId;
        missingPolls = 0;
        applyThinking(false, "session changed");
      }

      if (!sessionId) {
        return;
      }

      const status = await readStatusForSession(sessionId);

      // We may have been stopped during the await. The reset in stop() can
      // miss this case when lastThinking happens to be false already, and
      // continuing here would emit one final thinking=true at the very end of
      // the launcher's life, pinning the phone at "working" permanently.
      if (stopped) {
        return;
      }

      if (status === null) {
        missingPolls++;
        if (missingPolls >= MISSING_FILE_GRACE_POLLS) {
          applyThinking(false, "status file missing");
        }
        return;
      }
      missingPolls = 0;
      applyThinking(status === BUSY_STATUS, `status=${status}`);
    } catch (error) {
      logger.debug("[ClaudeStatusWatcher] poll failed:", error);
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
    applyThinking(false, "stopped");
    logger.debug("[ClaudeStatusWatcher] stopped");
  };
}

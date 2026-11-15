import { displayName } from "./display-name.js";
/** Remind once a queued run or a human wait has been sitting this long.
 *  Long enough that a short queue or stepping away stays quiet; short enough
 *  that forgotten work is not silent until the next day.
 *  The worker's STUCK_WORK_NOTIFY_AFTER_MS setting overrides it; the activity list keeps this value. */
export const STUCK_WORK_NOTIFY_AFTER_MS = 4 * 60 * 60 * 1000;

/** Cancel once that same work has been sitting this long.
 *  Leaves the hours after the reminder for someone to answer before the thread is freed.
 *  The worker's STUCK_WORK_EXPIRE_AFTER_MS setting overrides it. */
export const STUCK_WORK_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

const STUCK_WORK_MIN_AFTER_MS = 60 * 1000;
const STUCK_WORK_MAX_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** A self-hoster's override, in ms. Blank, invalid, or outside one minute to thirty days keeps `fallback`. */
function stuckWorkMsFromEnv(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(value) &&
    value >= STUCK_WORK_MIN_AFTER_MS &&
    value <= STUCK_WORK_MAX_AFTER_MS
    ? value
    : fallback;
}

function stuckWorkNotifyAfterMs(): number {
  return stuckWorkMsFromEnv(process.env.STUCK_WORK_NOTIFY_AFTER_MS, STUCK_WORK_NOTIFY_AFTER_MS);
}

/** A takeover request nobody acted on is cancelled much sooner: it holds the bot's computer,
 *  so later work for that bot waits behind it. Expires before the reminder would fire. */
export const TAKEOVER_WAIT_EXPIRE_AFTER_MS = 30 * 60 * 1000;

/** Marker on a thread.meta event so a reminder is sent once per waiting episode. */
export const STUCK_WORK_NOTICE = "stuck";

export const STUCK_WORK_STATUSES = ["queued", "waiting_input", "waiting_takeover"] as const;
export type StuckWorkStatus = (typeof STUCK_WORK_STATUSES)[number];

export type StuckWorkAction = "notify" | "expire" | "none";

export function isStuckWorkStatus(status: string): status is StuckWorkStatus {
  return (STUCK_WORK_STATUSES as readonly string[]).includes(status);
}

export function stuckWorkAgeMs(updatedAt: Date | string, now: Date): number {
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  return now.getTime() - at;
}

/** How long a run in this status may sit before the first reminder or cancellation. */
export function stuckWorkDueAfterMs(status: StuckWorkStatus): number {
  return Math.min(stuckWorkNotifyAfterMs(), stuckWorkExpireAfterMs(status));
}

/** `alreadyNotified` is for this episode (the run's current updatedAt), not an older one. */
export function stuckWorkAction(input: {
  status: StuckWorkStatus;
  ageMs: number;
  alreadyNotified: boolean;
}): StuckWorkAction {
  if (input.ageMs >= stuckWorkExpireAfterMs(input.status)) return "expire";
  if (input.ageMs >= stuckWorkNotifyAfterMs() && !input.alreadyNotified) return "notify";
  return "none";
}

/** True once a queued or human-waiting run is old enough to call out in the activity list. */
export function isAgedStuckWork(
  status: string,
  updatedAt: Date | string,
  now = Date.now(),
): boolean {
  if (!isStuckWorkStatus(status)) return false;
  return stuckWorkAgeMs(updatedAt, new Date(now)) >= STUCK_WORK_NOTIFY_AFTER_MS;
}

export function stuckWorkExpiredNonce(runId: string): string {
  return `stuck-expired:${runId}`;
}

/** Status line left in the thread when the wait is cancelled. */
export function stuckWorkStatusMessage(status: StuckWorkStatus): string {
  switch (status) {
    case "queued":
      return "Stopped. This stayed queued without starting.";
    case "waiting_input":
      return "Stopped. This was still waiting for an answer.";
    case "waiting_takeover":
      return "Stopped. This was still waiting for you on the screen.";
  }
}

export function stuckWorkStatusMessages(): readonly string[] {
  return STUCK_WORK_STATUSES.map((status) => stuckWorkStatusMessage(status));
}

export type StuckAttentionKind = "help" | "takeover" | "failure";

export function stuckWorkReminder(
  status: StuckWorkStatus,
  botName: string,
): { kind: StuckAttentionKind; title: string; body: string } {
  const name = botLabel(botName);
  switch (status) {
    case "queued":
      return {
        kind: "help",
        title: `${name} is still queued`,
        body: "It has been waiting to start.",
      };
    case "waiting_input":
      return {
        kind: "help",
        title: `${name} still needs an answer`,
        body: "This has been waiting on you.",
      };
    case "waiting_takeover":
      return {
        kind: "takeover",
        title: `${name} still needs you`,
        body: "The screen has been waiting.",
      };
  }
}

export function stuckWorkStoppedNotification(
  status: StuckWorkStatus,
  botName: string,
): { kind: "failure"; title: string; body: string } {
  return {
    kind: "failure",
    title: `${botLabel(botName)} stopped`,
    body: stuckWorkStatusMessage(status),
  };
}

function botLabel(name: string): string {
  return displayName(name, "Bot");
}

function stuckWorkExpireAfterMs(status: StuckWorkStatus): number {
  return status === "waiting_takeover"
    ? TAKEOVER_WAIT_EXPIRE_AFTER_MS
    : stuckWorkMsFromEnv(process.env.STUCK_WORK_EXPIRE_AFTER_MS, STUCK_WORK_EXPIRE_AFTER_MS);
}

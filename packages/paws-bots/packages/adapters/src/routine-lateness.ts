import { nextRoutineRunDateAcross } from "@rakazo/core";
import { localDateTime } from "./current-time.js";
import { routineTimerScheduledFor } from "./routine-coalescing.js";

/**
 * A recurring run that starts this long after its most recent scheduled occurrence is late
 * enough that time-of-day assumptions in its prompt ("morning brief") may no longer hold.
 * Measured from the most recent occurrence, so frequent routines that missed ticks are not flagged.
 */
export const LATE_ROUTINE_RUN_MS = 15 * 60_000;

/**
 * The occurrence a recurring timer run was due at when it started materially late (for
 * example after the host was offline at its scheduled time). Undefined for on-time runs
 * and for any run that is not a recurring timer tick.
 */
export function lateRoutineRunDueAt(
  run: { routineId: string | null; clientNonce: string | null },
  routine: { crons: string[]; timezone: string },
  now: Date,
): Date | undefined {
  if (!run.routineId) return undefined;
  const scheduledFor = routineTimerScheduledFor(run.routineId, run.clientNonce);
  if (!scheduledFor) return undefined;
  if (now.getTime() - scheduledFor.getTime() < LATE_ROUTINE_RUN_MS) return undefined;
  const nextAfter = (from: number) =>
    nextRoutineRunDateAcross(
      routine.crons,
      scheduledFor,
      new Date(from),
      routine.timezone,
    )?.getTime() ?? Number.POSITIVE_INFINITY;
  // Occurrences only move forward, so binary search for the most recent one due by
  // `now`: the earliest instant whose next occurrence is after `now`. The step count
  // grows only with the logarithm of the outage length.
  let latest = scheduledFor.getTime();
  if (nextAfter(latest) <= now.getTime()) {
    let after = now.getTime();
    while (after - latest > 1) {
      const middle = Math.floor((latest + after) / 2);
      if (nextAfter(middle) <= now.getTime()) latest = middle;
      else after = middle;
    }
    latest = after;
  }
  if (now.getTime() - latest < LATE_ROUTINE_RUN_MS) return undefined;
  return new Date(latest);
}

/** Tells a run that started late when it was due and when it started, in the routine's timezone. */
export function lateRoutineRunInstruction(dueAt: Date, now: Date, timezone: string): string {
  const zone = localDateTime(now, timezone) ? timezone : undefined;
  const format = (date: Date) =>
    zone
      ? `${localDateTime(date, zone)} (${zone})`
      : `${date.toISOString().replace(/\.\d{3}Z$/, "Z")} (UTC)`;
  return [
    `This scheduled run started late: it was due ${format(dueAt)} and started ${format(now)}.`,
    "Adapt anything that depends on the time of day to the actual time, skip steps that no longer make sense, and mention the delay when it matters to the user.",
  ].join(" ");
}

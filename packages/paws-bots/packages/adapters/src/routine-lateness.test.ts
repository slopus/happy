import { describe, expect, it } from "vitest";
import { routineTimerNonce } from "./routine-coalescing.js";
import { lateRoutineRunDueAt, lateRoutineRunInstruction } from "./routine-lateness.js";

const daily = { crons: ["0 8 * * *"], timezone: "America/New_York" };
const hourly = { crons: ["0 * * * *"], timezone: "America/New_York" };
// 08:00 in New York (UTC-04:00) on Monday 2026-10-19.
const mondayEight = "2026-10-19T12:00:00.000Z";
const timerRun = (scheduledFor: string) => ({
  routineId: "routine-1",
  clientNonce: routineTimerNonce("routine-1", scheduledFor),
});

/** The note the executor gives a run that starts at `now`, if it is late. */
const lateRoutineRunNote = (
  run: Parameters<typeof lateRoutineRunDueAt>[0],
  routine: Parameters<typeof lateRoutineRunDueAt>[1],
  now: Date,
) => {
  const dueAt = lateRoutineRunDueAt(run, routine, now);
  return dueAt && lateRoutineRunInstruction(dueAt, now, routine.timezone);
};

describe("lateRoutineRunInstruction", () => {
  it("adds nothing when the run starts close to its scheduled time", () => {
    expect(
      lateRoutineRunNote(timerRun(mondayEight), daily, new Date("2026-10-19T12:14:00Z")),
    ).toBeUndefined();
  });

  it("states the scheduled and actual start times in the routine's timezone", () => {
    const note = lateRoutineRunNote(timerRun(mondayEight), daily, new Date("2026-10-19T19:02:30Z"));
    expect(note).toContain(
      "it was due Monday, 2026-10-19 08:00 (UTC-04:00) (America/New_York) and started Monday, 2026-10-19 15:02 (UTC-04:00) (America/New_York).",
    );
  });

  it("measures a catch-up from the most recent missed occurrence", () => {
    // Created for Friday's 08:00; Saturday, Sunday and Monday were missed too.
    const note = lateRoutineRunNote(
      timerRun("2026-10-16T12:00:00.000Z"),
      daily,
      new Date("2026-10-19T19:02:00Z"),
    );
    expect(note).toContain("it was due Monday, 2026-10-19 08:00 (UTC-04:00)");
  });

  it("treats a frequent routine as on time when a recent occurrence is due", () => {
    expect(
      lateRoutineRunNote(timerRun(mondayEight), hourly, new Date("2026-10-19T19:05:00Z")),
    ).toBeUndefined();
    expect(
      lateRoutineRunNote(timerRun(mondayEight), hourly, new Date("2026-10-19T19:40:00Z")),
    ).toContain("it was due Monday, 2026-10-19 15:00 (UTC-04:00)");
  });

  it("finds the most recent occurrence after a very long outage", () => {
    // Created 50 days earlier; 1,200 hourly occurrences were missed since.
    expect(
      lateRoutineRunNote(
        timerRun("2026-08-30T12:00:00.000Z"),
        hourly,
        new Date("2026-10-19T19:40:00Z"),
      ),
    ).toContain("it was due Monday, 2026-10-19 15:00 (UTC-04:00)");
  });

  it("ignores runs that are not recurring timer ticks", () => {
    const at = new Date("2026-10-19T19:02:00Z");
    expect(
      lateRoutineRunNote({ routineId: "routine-1", clientNonce: null }, daily, at),
    ).toBeUndefined();
    expect(
      lateRoutineRunNote({ routineId: "routine-1", clientNonce: "manual-1" }, daily, at),
    ).toBeUndefined();
    expect(
      lateRoutineRunNote({ ...timerRun(mondayEight), routineId: "routine-2" }, daily, at),
    ).toBeUndefined();
  });

  it("falls back to UTC for an unusable timezone", () => {
    const note = lateRoutineRunNote(
      timerRun(mondayEight),
      { crons: ["0 12 * * *"], timezone: "Not/AZone" },
      new Date("2026-10-19T19:02:00Z"),
    );
    expect(note).toContain(
      "it was due 2026-10-19T12:00:00Z (UTC) and started 2026-10-19T19:02:00Z (UTC).",
    );
  });
});

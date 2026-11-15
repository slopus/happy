import { describe, expect, it } from "vitest";
import { routineScheduleDelayed } from "./routine-dispatch.js";

describe("routine schedule delay", () => {
  const now = Date.parse("2026-10-26T09:00:00Z");

  it("reports a due dispatch only after the startup grace period", () => {
    expect(routineScheduleDelayed({ active: true, nextRunAt: now - 300_000 }, now)).toBe(false);
    expect(routineScheduleDelayed({ active: true, nextRunAt: now - 300_001 }, now)).toBe(true);
  });

  it("does not label paused, event-only, future, or backed-off schedules as delayed", () => {
    for (const routine of [
      { active: false, nextRunAt: now - 600_000 },
      { active: true, nextRunAt: null },
      { active: true, nextRunAt: now + 1 },
      { active: true, nextRunAt: now + 86_400_000 },
      { active: true, nextRunAt: Number.NaN },
    ]) {
      expect(routineScheduleDelayed(routine, now)).toBe(false);
    }
  });

  it("compares instants rather than local calendar times across a DST change", () => {
    const scheduled = Date.parse("2026-11-01T01:55:00-04:00");
    const afterFallback = Date.parse("2026-11-01T01:05:00-05:00");
    expect(routineScheduleDelayed({ active: true, nextRunAt: scheduled }, afterFallback)).toBe(
      true,
    );
    expect(routineScheduleDelayed({ active: true, nextRunAt: now }, Number.NaN)).toBe(false);
  });
});

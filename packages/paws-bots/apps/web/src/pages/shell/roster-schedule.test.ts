import { describe, expect, it, vi } from "vitest";
import { createRosterSchedule, ROSTER_POLL_MS, ROSTER_SAFETY_POLL_MS } from "./roster-schedule";

function schedule() {
  let now = 0;
  const refresh = vi.fn();
  const roster = createRosterSchedule(refresh, () => now);
  return {
    refresh,
    roster,
    advance(ms: number) {
      for (let step = 0; step < ms; step += ROSTER_POLL_MS) {
        now += ROSTER_POLL_MS;
        roster.poll();
      }
    },
  };
}

describe("createRosterSchedule", () => {
  it("polls at the old cadence until the server signals", () => {
    const { refresh, advance } = schedule();
    advance(ROSTER_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("re-reads on each signal and polls only as a safety net while signals are live", () => {
    const { refresh, roster, advance } = schedule();
    roster.signals.changed();
    expect(refresh).not.toHaveBeenCalled();
    advance(ROSTER_SAFETY_POLL_MS - ROSTER_POLL_MS);
    expect(refresh).not.toHaveBeenCalled();
    roster.signals.changed();
    expect(refresh).toHaveBeenCalledTimes(1);
    advance(ROSTER_SAFETY_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("re-reads on a late opening signal, since the page's own load may be stale by then", () => {
    const { refresh, roster, advance } = schedule();
    advance(ROSTER_POLL_MS);
    roster.signals.changed();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("returns to the old cadence when the signals drop, and re-reads when they come back", () => {
    const { refresh, roster, advance } = schedule();
    roster.signals.changed();
    roster.signals.lost();
    advance(ROSTER_POLL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    roster.signals.changed();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

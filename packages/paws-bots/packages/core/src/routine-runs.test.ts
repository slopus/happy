import type { RoutineRun } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatCompactDuration,
  formatRoutineRunAt,
  mergeRoutineRunPages,
  routineHistoryPage,
  routineRunAt,
  routineRunLateness,
} from "./routine-runs.js";

const run: RoutineRun = {
  id: "run-1",
  botId: "bot-1",
  groupId: null,
  status: "completed",
  error: null,
  createdAt: "2026-01-02T11:59:00Z",
  startedAt: "2026-01-02T12:00:00Z",
  lateSince: null,
  completedAt: "2026-01-02T12:01:22Z",
  messageId: null,
};

describe("formatCompactDuration", () => {
  it.each([
    [0, "0ms"],
    [850, "850ms"],
    [999, "999ms"],
    [1000, "1s"],
    [4200, "4.2s"],
    [12000, "12s"],
    [19179, "19s"],
    [60000, "1m 00s"],
    [65000, "1m 05s"],
    [103000, "1m 43s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatCompactDuration(ms)).toBe(expected);
  });

  it("omits unusable durations", () => {
    expect(formatCompactDuration(undefined)).toBeNull();
    expect(formatCompactDuration(null)).toBeNull();
    expect(formatCompactDuration(Number.NaN)).toBeNull();
    expect(formatCompactDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatCompactDuration(-1)).toBeNull();
  });
});

describe("routine runs", () => {
  it("says how late a scheduled run started in its largest whole unit", () => {
    const late = (lateSince: string | null, startedAt: string | null = run.startedAt) =>
      routineRunLateness({ ...run, lateSince, startedAt });
    expect(late(null)).toBeNull();
    expect(late("2026-01-02T11:00:00Z", null)).toBeNull();
    expect(late("2026-01-02T11:44:30Z")).toEqual({ unit: "minutes", count: 15 });
    expect(late("2026-01-02T11:00:01Z")).toEqual({ unit: "minutes", count: 59 });
    expect(late("2026-01-02T11:00:00Z")).toEqual({ unit: "hours", count: 1 });
    expect(late("2026-01-01T12:00:01Z")).toEqual({ unit: "hours", count: 23 });
    expect(late("2026-01-01T12:00:00Z")).toEqual({ unit: "days", count: 1 });
    expect(late("2025-12-30T09:00:00Z")).toEqual({ unit: "days", count: 3 });
  });

  it("dates a run by its start, else by when it was queued", () => {
    expect(routineRunAt(run)).toBe(run.startedAt);
    expect(routineRunAt({ ...run, startedAt: null })).toBe(run.createdAt);
  });

  it("joins pages in order and shows a run that moved pages once", () => {
    const older = { ...run, id: "run-2" };
    const oldest = { ...run, id: "run-3" };
    expect(
      mergeRoutineRunPages([
        { runs: [run, older], nextCursor: { id: older.id, createdAt: older.createdAt } },
        { runs: [older, oldest], nextCursor: null },
      ]).map((item) => item.id),
    ).toEqual(["run-1", "run-2", "run-3"]);
  });
});

describe("formatRoutineRunAt", () => {
  it("leaves out the year only within the current one", () => {
    const local = { ...run, startedAt: "2026-01-02T12:00:00" };
    expect(formatRoutineRunAt(local, "en-US", new Date("2026-06-01T00:00:00"))).toBe(
      "Jan 2, 12:00 PM",
    );
    expect(formatRoutineRunAt(local, "en-US", new Date("2027-06-01T00:00:00"))).toBe(
      "Jan 2, 2026, 12:00 PM",
    );
  });
});

describe("routineHistoryPage", () => {
  it("asks for a short first page, then fuller older pages", () => {
    const cursor = { id: "run-1", createdAt: run.createdAt };
    expect(routineHistoryPage("routine-1", null)).toEqual({ routineId: "routine-1", limit: 5 });
    expect(routineHistoryPage("routine-1", cursor)).toEqual({
      routineId: "routine-1",
      before: cursor,
      limit: 20,
    });
  });
});

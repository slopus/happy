import { afterEach, describe, expect, it, vi } from "vitest";
import { mapRoutine } from "./routines.js";

afterEach(() => vi.useRealTimers());

describe("routine dispatch DTO", () => {
  it("computes schedule delay on the server without changing persisted schedule state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
    const row = {
      id: "routine-1",
      botId: "bot-1",
      name: "Morning report",
      prompt: "Prepare the report.",
      crons: ["0 8 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      emailSenders: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      watch: null,
      watchState: null,
      lastRunAt: null,
      nextRunAt: new Date("2026-10-26T08:00:00Z"),
      createdAt: new Date("2026-10-25T00:00:00Z"),
    };
    expect(mapRoutine(row)).toMatchObject({
      scheduleDelayed: true,
      active: true,
      nextRunAt: "2026-10-26T08:00:00.000Z",
    });
    expect(mapRoutine({ ...row, active: false }).scheduleDelayed).toBe(false);
    expect(mapRoutine({ ...row, nextRunAt: null }).scheduleDelayed).toBe(false);
    expect(
      mapRoutine({ ...row, nextRunAt: new Date("2026-10-26T10:00:00Z") }).scheduleDelayed,
    ).toBe(false);
    expect(row.nextRunAt.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });
});

import { describe, expect, it } from "vitest";
import {
  chatSnoozed,
  chatWoke,
  createSnoozeQueue,
  nextChatWake,
  snoozePresetTime,
  snoozeWakeDay,
} from "./chat-snooze.js";

const now = Date.parse("2026-11-07T12:00:00Z");
const later = "2026-11-07T15:00:00.000Z";
const earlier = "2026-11-07T09:00:00.000Z";

describe("chat snooze", () => {
  it("hides a chat until it wakes, then marks it woken", () => {
    expect(chatSnoozed({ snoozedUntil: later }, now)).toBe(true);
    expect(chatWoke({ snoozedUntil: later }, now)).toBe(false);
    expect(chatSnoozed({ snoozedUntil: earlier }, now)).toBe(false);
    expect(chatWoke({ snoozedUntil: earlier }, now)).toBe(true);
    expect(chatSnoozed({ snoozedUntil: null }, now)).toBe(false);
    expect(chatWoke({ snoozedUntil: "not a date" }, now)).toBe(false);
  });

  it("finds the next wake among future snoozes", () => {
    const soon = "2026-11-07T13:00:00.000Z";
    expect(
      nextChatWake(
        [{ snoozedUntil: later }, { snoozedUntil: earlier }, { snoozedUntil: soon }],
        now,
      ),
    ).toBe(Date.parse(soon));
    expect(nextChatWake([{ snoozedUntil: earlier }, {}], now)).toBeNull();
  });

  it("wakes presets at 9 the next morning or the next Monday", () => {
    // Saturday 7 November 2026, 14:30 local.
    const saturday = new Date(2026, 10, 7, 14, 30);
    expect(snoozePresetTime("threeHours", saturday)).toEqual(new Date(2026, 10, 7, 17, 30));
    expect(snoozePresetTime("tomorrow", saturday)).toEqual(new Date(2026, 10, 8, 9));
    expect(snoozePresetTime("nextWeek", saturday)).toEqual(new Date(2026, 10, 9, 9));
    // On a Monday, next week is the following Monday.
    expect(snoozePresetTime("nextWeek", new Date(2026, 10, 9, 8))).toEqual(
      new Date(2026, 10, 16, 9),
    );
  });

  it("names a wake day only when it is not today", () => {
    const saturday = new Date(2026, 10, 7, 14, 30);
    expect(snoozeWakeDay(new Date(2026, 10, 7, 18), saturday)).toBeNull();
    expect(snoozeWakeDay(new Date(2026, 10, 9, 9), saturday)).toEqual({ weekday: "short" });
    // Six calendar days ahead is still within the week, even when that is under six full days.
    expect(snoozeWakeDay(new Date(2026, 10, 13, 9), saturday)).toEqual({ weekday: "short" });
    // A week ahead names the date, so it isn't mistaken for today's weekday.
    expect(snoozeWakeDay(new Date(2026, 10, 14, 9), saturday)).toEqual({
      month: "short",
      day: "numeric",
    });
    expect(snoozeWakeDay(new Date(2026, 10, 20, 9), saturday)).toEqual({
      month: "short",
      day: "numeric",
    });
  });
});

describe("snooze queue", () => {
  const tomorrow = "2026-11-08T09:00:00.000Z";
  function setup() {
    const requests: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const shown: Array<string | null> = [];
    const settled: Array<boolean> = [];
    const queue = createSnoozeQueue();
    const change = {
      send: () =>
        new Promise<void>((resolve, reject) => {
          requests.push({ resolve, reject });
        }),
      apply: (until: string | null) => shown.push(until),
      settled: (failed: { error: unknown } | null) => settled.push(failed !== null),
    };
    return { requests, shown, settled, queue, change };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("goes back to what the server has when a snooze and its quick undo both fail", async () => {
    const { requests, shown, settled, queue, change } = setup();
    queue("bot:a", tomorrow, null, change);
    queue("bot:a", null, tomorrow, change);
    await flush();
    requests[0]!.reject(new Error("offline"));
    await flush();
    requests[1]!.reject(new Error("offline"));
    await flush();
    expect(shown.at(-1)).toBeNull();
    expect(settled).toEqual([true]);
  });

  it("keeps a saved snooze when the undo after it fails", async () => {
    const { requests, shown, settled, queue, change } = setup();
    queue("bot:a", tomorrow, null, change);
    queue("bot:a", null, tomorrow, change);
    await flush();
    requests[0]!.resolve();
    await flush();
    requests[1]!.reject(new Error("offline"));
    await flush();
    expect(shown.at(-1)).toBe(tomorrow);
    expect(settled).toEqual([true]);
  });

  it("settles once, after the newest choice is saved", async () => {
    const { requests, settled, queue, change } = setup();
    queue("bot:a", tomorrow, null, change);
    queue("bot:a", null, tomorrow, change);
    await flush();
    requests[0]!.resolve();
    await flush();
    expect(settled).toEqual([]);
    requests[1]!.resolve();
    await flush();
    expect(settled).toEqual([false]);
  });

  it("lets only the newest of repeated choices roll back", async () => {
    const { requests, shown, settled, queue, change } = setup();
    queue("bot:a", tomorrow, null, change);
    queue("bot:a", null, tomorrow, change);
    queue("bot:a", tomorrow, null, change);
    await flush();
    requests[0]!.reject(new Error("offline"));
    await flush();
    // The first choice failing neither rolls back nor reloads over the two after it.
    expect(shown.at(-1)).toBe(tomorrow);
    expect(settled).toEqual([]);
    requests[1]!.resolve();
    await flush();
    requests[2]!.resolve();
    await flush();
    expect(settled).toEqual([false]);
  });

  it("never starts a save before the one ahead of it finishes", async () => {
    const { requests, queue, change } = setup();
    queue("bot:a", tomorrow, null, change);
    queue("bot:a", null, tomorrow, change);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
  });
});

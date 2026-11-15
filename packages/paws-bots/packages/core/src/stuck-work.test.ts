import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
  TAKEOVER_WAIT_EXPIRE_AFTER_MS,
} from "./stuck-work.js";

describe("stuck work age", () => {
  it("stays quiet until the reminder, then cancels at the longer limit", () => {
    const action = (ageMs: number, alreadyNotified: boolean) =>
      stuckWorkAction({ status: "waiting_input", ageMs, alreadyNotified });
    expect(stuckWorkDueAfterMs("waiting_input")).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS, false)).toBe("none");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS - 1, false)).toBe("none");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS, false)).toBe("notify");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS, true)).toBe("none");
    expect(action(STUCK_WORK_EXPIRE_AFTER_MS - 1, true)).toBe("none");
    expect(action(STUCK_WORK_EXPIRE_AFTER_MS, true)).toBe("expire");
  });

  it("cancels a takeover nobody acted on after half an hour", () => {
    const action = (ageMs: number) =>
      stuckWorkAction({ status: "waiting_takeover", ageMs, alreadyNotified: false });
    expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(TAKEOVER_WAIT_EXPIRE_AFTER_MS);
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS - 1)).toBe("none");
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS)).toBe("expire");
  });

  it("treats only queued and human waits as stuck", () => {
    expect(isStuckWorkStatus("queued")).toBe(true);
    expect(isStuckWorkStatus("waiting_input")).toBe(true);
    expect(isStuckWorkStatus("waiting_takeover")).toBe(true);
    expect(isStuckWorkStatus("running")).toBe(false);
    expect(isAgedStuckWork("queued", new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS))).toBe(true);
    expect(isAgedStuckWork("running", new Date(0))).toBe(false);
    expect(isAgedStuckWork("queued", "not-a-date")).toBe(false);
  });

  it("uses a distinct status line and a matching stopped notice", () => {
    const messages = STUCK_WORK_STATUSES_FOR_TEST();
    expect(new Set(messages).size).toBe(messages.length);
    expect(stuckWorkStatusMessage("waiting_takeover")).toMatch(/screen/);
    expect(stuckWorkStoppedNotification("waiting_input", "  ")).toEqual({
      kind: "failure",
      title: "Bot stopped",
      body: stuckWorkStatusMessage("waiting_input"),
    });
    expect(stuckWorkReminder("waiting_takeover", "Ada")).toMatchObject({
      kind: "takeover",
      title: "Ada still needs you",
    });
    expect(stuckWorkReminder("queued", "Ada").kind).toBe("help");
  });
});

describe("stuck work timeouts from the environment", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads both limits from the environment and keeps the 30 minute takeover limit", () => {
    vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", String(HOUR));
    vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", String(2 * HOUR));
    const action = (ageMs: number, alreadyNotified = false) =>
      stuckWorkAction({ status: "waiting_input", ageMs, alreadyNotified });
    expect(stuckWorkDueAfterMs("waiting_input")).toBe(HOUR);
    expect(action(HOUR - 1)).toBe("none");
    expect(action(HOUR)).toBe("notify");
    expect(action(2 * HOUR - 1, true)).toBe("none");
    expect(action(2 * HOUR, true)).toBe("expire");
    expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(TAKEOVER_WAIT_EXPIRE_AFTER_MS);
  });

  it("can end a wait before the default reminder would go out", () => {
    vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", String(2 * HOUR));
    expect(stuckWorkDueAfterMs("waiting_input")).toBe(2 * HOUR);
    expect(stuckWorkAction({ status: "queued", ageMs: 2 * HOUR, alreadyNotified: false })).toBe(
      "expire",
    );
  });

  it("keeps today's limits when the settings are unset, blank, or out of range", () => {
    const limits = () => ({
      due: stuckWorkDueAfterMs("waiting_input"),
      expireAt: stuckWorkAction({
        status: "waiting_input",
        ageMs: STUCK_WORK_EXPIRE_AFTER_MS - 1,
        alreadyNotified: true,
      }),
    });
    expect(limits()).toEqual({ due: 4 * HOUR, expireAt: "none" });
    for (const value of ["", "  ", "abc", "-1", "0", "59999", String(31 * DAY), "Infinity"]) {
      vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", value);
      vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", value);
      expect(limits()).toEqual({ due: STUCK_WORK_NOTIFY_AFTER_MS, expireAt: "none" });
      expect(stuckWorkAction({ status: "waiting_input", ageMs: DAY, alreadyNotified: true })).toBe(
        "expire",
      );
    }
  });

  it("accepts the bounds, one minute and thirty days", () => {
    vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", "60000");
    vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", String(30 * DAY));
    expect(stuckWorkDueAfterMs("queued")).toBe(60_000);
    expect(stuckWorkAction({ status: "queued", ageMs: 30 * DAY - 1, alreadyNotified: true })).toBe(
      "none",
    );
    expect(stuckWorkAction({ status: "queued", ageMs: 30 * DAY, alreadyNotified: true })).toBe(
      "expire",
    );
  });

  it("leaves the activity list's attention threshold at the default", () => {
    vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", String(HOUR));
    const hourOld = new Date(Date.now() - HOUR);
    expect(isAgedStuckWork("queued", hourOld)).toBe(false);
  });
});

function STUCK_WORK_STATUSES_FOR_TEST(): string[] {
  return [...stuckWorkStatusMessages()];
}

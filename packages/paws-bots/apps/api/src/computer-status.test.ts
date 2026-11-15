import { ComputerStatusSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { toComputerStatus } from "./computer-status.js";

describe("toComputerStatus", () => {
  it("shows a quarantined computer as an error without making its screen available", () => {
    expect(
      toComputerStatus("bot", {
        kind: "novita",
        state: "quarantined",
        scope: "team",
        controlHolder: "none",
        homeRevision: "saved",
      }),
    ).toMatchObject({ state: "error", screenAvailable: false });
  });
  it("warns at 90% full until the user hides it, and again once the disk fills further", () => {
    const computer = {
      kind: "docker",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "saved",
      diskUsedBytes: 91n,
      diskFreeBytes: 9n,
    };
    const status = (changes: object) => toComputerStatus("bot", { ...computer, ...changes });
    expect(status({}).diskFullPercent).toBe(91);
    expect(ComputerStatusSchema.parse(status({})).diskFullPercent).toBe(91);
    expect(status({ diskUsedBytes: 89n, diskFreeBytes: 11n }).diskFullPercent).toBeUndefined();
    expect(status({ diskDismissedPercent: 91 }).diskFullPercent).toBeUndefined();
    expect(status({ diskDismissedPercent: 90 }).diskFullPercent).toBe(91);
    expect(status({ diskUsedBytes: null }).diskFullPercent).toBeUndefined();
  });
  it("passes through what the bot is doing with its computer", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer)).toMatchObject({
      busyBotName: null,
      takeoverRequested: false,
    });
    expect(
      toComputerStatus("bot-1", computer, { busyBotName: "Writer", takeoverRequested: true }),
    ).toMatchObject({ busyBotName: "Writer", takeoverRequested: true });
  });

  it("tells only the person holding control their own lease", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlLeaseId: "lease-1",
      controlUserId: "user-1",
      userId: "owner",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer, undefined, true, "user-1").controlLeaseId).toBe(
      "lease-1",
    );
    // Another bot's screen on the same Team computer is not this lease's.
    expect(
      toComputerStatus("bot-2", computer, undefined, true, "user-1").controlLeaseId,
    ).toBeUndefined();
    const watcher = toComputerStatus("bot-1", computer, undefined, true, "user-2");
    expect(watcher.controlLeaseId).toBeUndefined();
    expect(watcher.controlledByOther).toBe(true);
  });

  it("sandbox-none-computer-status", () => {
    const stopped = toComputerStatus("bot-1", {
      kind: "none",
      state: "stopped",
      scope: "team",
      controlHolder: "none",
      homeRevision: "empty",
    });
    expect(ComputerStatusSchema.parse(stopped)).toMatchObject({
      kind: "none",
      state: "stopped",
      canUpdate: false,
      terminalAvailable: false,
      screenAvailable: false,
    });

    const running = toComputerStatus("bot-1", {
      kind: "none",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "empty",
    });
    expect(ComputerStatusSchema.parse(running)).toMatchObject({
      state: "stopped",
      canUpdate: false,
      terminalAvailable: false,
      screenAvailable: false,
    });
  });

  it("hides update on desktop computers", () => {
    expect(
      toComputerStatus("bot-1", {
        kind: "desktop",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(false);
    expect(
      toComputerStatus("bot-1", {
        kind: "e2b",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(true);
  });
});

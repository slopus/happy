import { describe, expect, it } from "vitest";
import {
  canReleaseScreenLease,
  canTakeScreenLease,
  parseScreenLeaseId,
  screenLeaseId,
} from "./screen-lease.js";

describe("screenLeaseId", () => {
  it("puts the fence after the run id, including boot ids that contain a colon", () => {
    expect(screenLeaseId("run-1", 8)).toBe("run-1:8");
    expect(screenLeaseId("boot:abc", 3)).toBe("boot:abc:3");
    expect(parseScreenLeaseId("boot:abc:3")).toEqual({ ownerId: "boot:abc", fence: 3 });
    expect(parseScreenLeaseId("run-1")).toEqual({ ownerId: "run-1", fence: 0 });
  });
});

describe("canTakeScreenLease", () => {
  it("lets a newer fence reclaim the same bot screen", () => {
    expect(canTakeScreenLease("run-1:1", "run-2:2")).toBe(true);
    expect(canTakeScreenLease("run-1:1", "run-1:8")).toBe(true);
  });

  it("rejects a delayed request from an older execution", () => {
    expect(canTakeScreenLease("run-2:2", "run-1:1")).toBe(false);
    expect(canTakeScreenLease("run-1:8", "run-1:1")).toBe(false);
    expect(canTakeScreenLease("run-2:2", undefined)).toBe(false);
    expect(canTakeScreenLease("run-1:2", "run-2:2")).toBe(false);
  });
});

describe("canReleaseScreenLease", () => {
  it("lets the same run release after a takeover fence bump", () => {
    expect(canReleaseScreenLease("run-1:1", "run-1:8")).toBe(true);
    expect(canReleaseScreenLease("run-1:1", "run-1:1")).toBe(true);
  });

  it("rejects a stale finalizer after a newer run reclaimed the screen", () => {
    expect(canReleaseScreenLease("run-2:2", "run-1:1")).toBe(false);
    expect(canReleaseScreenLease("run-1:1", "run-2:5")).toBe(false);
  });
});

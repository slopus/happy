import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { setThreadSnooze } from "./thread-read-state.js";
import type { ThreadTarget } from "./thread-target.js";

describe("setThreadSnooze", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  // Rejected before the database is touched.
  const prisma = {} as PrismaClient;
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const target = { threadId: "thread" } as ThreadTarget;

  it.each([
    ["the past", "2026-11-07T11:00:00Z"],
    ["more than a year ahead", "2027-11-09T12:00:00Z"],
  ])("rejects a wake time in %s", async (_label, until) => {
    await expect(setThreadSnooze(prisma, actor, target, until, now)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

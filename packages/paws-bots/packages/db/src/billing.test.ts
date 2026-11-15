import { describe, expect, it, vi } from "vitest";
import { hasModelAccess, memberHasModelAccess, ownerHadTrial } from "./billing.js";
import type { PrismaClient } from "./client.js";

describe("model access", () => {
  const now = new Date("2030-01-15T12:00:00.000Z");
  const later = new Date("2030-02-14T12:00:00.000Z");
  it.each([
    { mode: null, balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: later, status: null, access: true },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: now, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: null, status: "active", access: true },
    // A top-up does not pay for running your own key.
    { mode: "byok", balanceMicros: 5n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    { mode: null, balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    // Spent credits do not leave own-key runs on other providers free.
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: "canceled", access: false },
  ])("$mode with balance $balanceMicros and $status: $access", ({ status, access, ...credits }) => {
    expect(hasModelAccess(credits, status, now)).toBe(access);
  });
});

describe("one trial per person", () => {
  function prisma(usedAt: Date | null) {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = {
      user: { findUnique: vi.fn().mockResolvedValue({ billingTrialUsedAt: usedAt }) },
      member: { findFirst },
    } as unknown as PrismaClient;
    return { client, findFirst };
  }

  it("counts free own-key days against the own-key trial only", async () => {
    const { client, findFirst } = prisma(null);
    await ownerHadTrial(client, "user-1", "byok");
    await ownerHadTrial(client, "user-1", "managed");
    const [byok, managed] = findFirst.mock.calls.map(([query]) => query.where.organization);
    expect(JSON.stringify(byok)).toContain("byokFreeUntil");
    expect(JSON.stringify(managed)).not.toContain("byokFreeUntil");
    expect(JSON.stringify(managed)).toContain("subscribedAt");
  });

  it("treats the user-level mark as a used trial for either plan", async () => {
    const { client, findFirst } = prisma(new Date());
    await expect(ownerHadTrial(client, "user-1", "managed")).resolves.toBe(true);
    await expect(ownerHadTrial(client, "user-1", "byok")).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

it("looks up the membership by space and user alone when given a whole run", async () => {
  const findUnique = vi.fn().mockResolvedValue(null);
  const client = { spaceMember: { findUnique } } as unknown as PrismaClient;
  const run = { id: "run-1", botId: "bot-1", spaceId: "space-1", userId: "user-1" };
  await memberHasModelAccess(client, run);
  expect(findUnique.mock.calls[0]?.[0].where).toEqual({
    spaceId_userId: { spaceId: "space-1", userId: "user-1" },
  });
});

import type { BillingProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createReferrals } from "./referrals.js";

/** Just the reads and writes a claim makes, so the self-referral rule runs offline. */
function fakeDatabase(referrerMembers: string[]) {
  const createMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    referralCode: {
      findUnique: vi.fn(async () => ({ organizationId: "org-referrer", code: "abc" })),
    },
    billingAccount: { findUnique: vi.fn(async () => null) },
    member: {
      count: vi.fn(async ({ where }: { where: { userId: string } }) =>
        referrerMembers.includes(where.userId) ? 1 : 0,
      ),
    },
    referral: { createMany },
  } as unknown as PrismaClient;
  return { prisma, createMany };
}

const provider = { grantBalanceCredit: vi.fn() } as unknown as BillingProvider;

describe("referral claims", () => {
  it("records a friend's claim", async () => {
    const { prisma, createMany } = fakeDatabase(["user-referrer"]);
    const referrals = createReferrals({ prisma, provider, webOrigin: "https://app.test" });
    await referrals.claim("org-friend", "abc", "user-friend");
    expect(createMany).toHaveBeenCalledOnce();
  });

  it("ignores a code from an organization the claiming owner belongs to", async () => {
    const { prisma, createMany } = fakeDatabase(["user-referrer", "user-owner"]);
    const referrals = createReferrals({ prisma, provider, webOrigin: "https://app.test" });
    await referrals.claim("org-second", "abc", "user-owner");
    expect(createMany).not.toHaveBeenCalled();
  });
});

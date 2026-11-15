import { randomUUID } from "node:crypto";
import { MODEL_CREDIT_CAP_REACHED_ERROR } from "@rakazo/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { modelCreditCapStatus, setModelCreditCap } from "./model-credit-cap.js";
import {
  creditAccount,
  reconcileCreditPurchase,
  reserveModelCredits,
  settleModelCredits,
} from "./model-credits.js";
import { asSystem, runAsTenant } from "./row-security.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("operator model credit caps", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let userId: string;
  let organizations: string[];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });
  beforeEach(async () => {
    userId = randomUUID();
    await prisma.user.create({
      data: { id: userId, name: "Credit fixture", email: `${userId}@example.test` },
    });
    organizations = [randomUUID(), randomUUID()];
    for (const organizationId of organizations) {
      await prisma.organization.create({
        data: { id: organizationId, name: "Credits", slug: organizationId, createdAt: new Date() },
      });
      await creditAccount(prisma, organizationId);
      await reconcileCreditPurchase(prisma, organizationId, {
        id: randomUUID(),
        amountCents: 10000,
      });
    }
  });
  afterEach(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.delete({ where: { id: userId } });
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const reserve = (usd: number, organizationId = organizations[0]!, callId = randomUUID()) =>
    reserveModelCredits(prisma, organizationId, usd, { userId, callId });

  it("allows normal uncapped use and counts prior usage against a newly set ceiling", async () => {
    const call = await reserve(3);
    await settleModelCredits(prisma, call, 1.5);
    await setModelCreditCap(prisma, userId, 2_000_000n);
    expect(await modelCreditCapStatus(prisma, userId)).toEqual({
      capMicros: 2_000_000n,
      committedMicros: 1_500_000n,
      remainingMicros: 500_000n,
    });
    await expect(reserve(0.500001)).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
    await expect(reserve(0.5)).resolves.toBeTypeOf("string");
    await expect(reserve(0.000001)).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
  });

  it("excludes ambiguous legacy baselines while enforcing attributed hosted charges", async () => {
    await prisma.billingAuditEvent.createMany({
      data: [
        {
          source: `baseline:credit:${randomUUID()}`,
          kind: "baseline",
          organizationId: organizations[0]!,
          amountMicros: -10_000_000n,
          details: { amountMicros: "-10000000", pending: false },
        },
        {
          source: `baseline:usage:${randomUUID()}`,
          kind: "usage_baseline",
          userId,
          details: { costUsd: 20, userId },
        },
      ],
    });
    await setModelCreditCap(prisma, userId, 2_000_000n);
    expect((await modelCreditCapStatus(prisma, userId)).committedMicros).toBe(0n);
    await reserve(2);
    await expect(reserve(0.01)).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
  });

  it("serializes concurrent reservations for the same user across organizations", async () => {
    await setModelCreditCap(prisma, userId, 2_000_000n);
    const calls = await Promise.allSettled(organizations.map((id) => reserve(1.5, id)));
    expect(calls.filter((call) => call.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((call) => call.status === "rejected")).toHaveLength(1);
    expect((await modelCreditCapStatus(prisma, userId)).committedMicros).toBe(1_500_000n);
  });

  it("keeps unknown holds, releases unused estimates, and permits idempotent replay at the cap", async () => {
    await setModelCreditCap(prisma, userId, 2_000_000n);
    const callId = randomUUID();
    const call = await reserve(2, organizations[0], callId);
    await expect(reserve(2, organizations[0], callId)).resolves.toBe(call);
    await settleModelCredits(prisma, call, null);
    await expect(reserve(0.01)).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
    await settleModelCredits(prisma, call, 0.25);
    await expect(reserve(1.75)).resolves.toBeTypeOf("string");
  });

  it("cannot be bypassed by purchases or deleting an organization", async () => {
    await setModelCreditCap(prisma, userId, 2_000_000n);
    const call = await reserve(2);
    await settleModelCredits(prisma, call, 2);
    await reconcileCreditPurchase(prisma, organizations[1]!, {
      id: randomUUID(),
      amountCents: 50000,
    });
    await prisma.organization.delete({ where: { id: organizations[0]! } });
    await expect(reserve(0.01, organizations[1])).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
    await setModelCreditCap(prisma, userId, null);
    await expect(reserve(3, organizations[1])).resolves.toBeTypeOf("string");
  });

  it("checks the full journal even in a tenant context and leaves other users unaffected", async () => {
    await setModelCreditCap(prisma, userId, 2_000_000n);
    await reserve(2);
    await expect(
      runAsTenant({ spaceId: "unused", userId }, () =>
        reserveModelCredits(db.prisma, organizations[0]!, 1, { userId }),
      ),
    ).rejects.toThrow(MODEL_CREDIT_CAP_REACHED_ERROR);
    const other = randomUUID();
    await prisma.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test` },
    });
    try {
      await expect(
        reserveModelCredits(prisma, organizations[0]!, 3, { userId: other }),
      ).resolves.toBeTypeOf("string");
    } finally {
      await prisma.user.delete({ where: { id: other } });
    }
  });

  it("audits changes and validates limits without changing the credit balance or account status", async () => {
    await expect(setModelCreditCap(prisma, userId, -1n)).rejects.toThrow("Usage cap");
    await expect(setModelCreditCap(prisma, userId, 10_000_000_001n)).rejects.toThrow("Usage cap");
    await setModelCreditCap(prisma, userId, 0n);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.deactivatedAt).toBeNull();
    expect((await creditAccount(prisma, organizations[0]!)).balanceMicros).toBe(100_000_000n);
    const audit = await prisma.billingAuditEvent.findFirstOrThrow({
      where: { userId, kind: "usage_cap_changed" },
    });
    expect(audit.details).toEqual({ previousMicros: null, capMicros: "0", by: "operator" });
  });
});

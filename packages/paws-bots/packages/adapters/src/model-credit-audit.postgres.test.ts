import type { AgentRuntimeEvent, AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  creditAccount,
  reconcileCreditPurchase,
  recordModelCreditReceipt,
  recordUsage,
  reserveModelCredits,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createModelCreditReconciler } from "./model-credit-reconciler.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("durable model credit audit", () => {
  let db: ReturnType<typeof createDb>, prisma: PrismaClient;
  const fixtures: Array<{ organizationId: string; userId: string }> = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });
  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      await prisma.organization.deleteMany({ where: { id: f.organizationId } });
      await prisma.user.deleteMany({ where: { id: f.userId } });
    }
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  async function fixture() {
    const id = `audit-${process.pid}-${crypto.randomUUID()}`;
    const organizationId = `${id}-org`,
      userId = `${id}-user`,
      spaceId = `${id}-space`;
    fixtures.push({ organizationId, userId });
    await prisma.user.create({
      data: { id: userId, name: "Audit fixture", email: `${id}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Audit fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Audit fixture" } });
    await creditAccount(prisma, organizationId);
    await prisma.modelCreditAccount.update({
      where: { organizationId },
      data: { mode: "credits" },
    });
    await reconcileCreditPurchase(prisma, organizationId, {
      id: `${id}-purchase`,
      amountCents: 1000,
    });
    const callId = `${id}-call`;
    await reserveModelCredits(prisma, organizationId, 2, {
      callId,
      userId,
      spaceId,
      provider: "openrouter",
      model: "fixture",
    });
    const usage: AgentUsage = {
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.25,
      costSource: "provider-reported",
      providerRequestId: `gen-${id}`,
    };
    const event: Extract<AgentRuntimeEvent, { type: "usage" }> = {
      type: "usage",
      provider: "openrouter",
      model: "fixture",
      callId,
      ...usage,
    };
    return { organizationId, userId, spaceId, callId, usage, event };
  }
  it("shares call ids and commits usage + settlement exactly once under replay", async () => {
    const f = await fixture();
    await recordModelCreditReceipt(prisma, f.callId, f.usage);
    await Promise.all([recordUsage(prisma, f.event, f), recordUsage(prisma, f.event, f)]);
    expect(await prisma.usageRecord.count({ where: { callId: f.callId } })).toBe(1);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    const events = await prisma.billingAuditEvent.findMany({ where: { callId: f.callId } });
    expect(events.filter((e) => e.kind === "reservation")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "settlement")).toHaveLength(1);
    expect(events.some((e) => e.kind === "usage")).toBe(true);
  });
  it("rolls back usage and journal inserts when attribution does not match", async () => {
    const f = await fixture();
    await expect(recordUsage(prisma, f.event, { ...f, userId: "wrong-user" })).rejects.toThrow(
      "attribution",
    );
    expect(await prisma.usageRecord.count({ where: { callId: f.callId } })).toBe(0);
    expect(
      await prisma.billingAuditEvent.count({ where: { callId: f.callId, kind: "usage" } }),
    ).toBe(0);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(8_000_000n);
  });
  it("recovers a durable receipt when the process died before usage insertion", async () => {
    const f = await fixture();
    await recordModelCreditReceipt(prisma, f.callId, f.usage);
    await createModelCreditReconciler({ prisma, now: () => new Date(Date.now() + 10 * 60_000) })();
    expect(await prisma.usageRecord.count({ where: { callId: f.callId } })).toBe(1);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    expect(await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } })).toMatchObject(
      { pending: false, reconciliationState: "complete" },
    );
  });
  it("recovers an interrupted stream by its provider generation id", async () => {
    const f = await fixture();
    await prisma.modelCreditEntry.update({
      where: { callId: f.callId },
      data: { providerRequestId: f.usage.providerRequestId },
    });
    const lookup: ModelUsageLookup = {
      provider: "openrouter",
      lookupUsage: vi.fn(async () => f.usage),
    };
    const reconcile = createModelCreditReconciler({
      prisma,
      lookup,
      now: () => new Date(Date.now() + 10 * 60_000),
    });
    await Promise.all([reconcile(), reconcile()]);
    expect(lookup.lookupUsage).toHaveBeenCalledTimes(1);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
  });
  it("applies a saved receipt over an existing unknown usage row before completing", async () => {
    const f = await fixture();
    await recordUsage(prisma, { ...f.event, costUsd: null, costSource: null }, f);
    await recordModelCreditReceipt(prisma, f.callId, f.usage);
    await createModelCreditReconciler({ prisma, now: () => new Date(Date.now() + 10 * 60_000) })();
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
      costUsd: 0.25,
      costSource: "provider-reported",
    });
    expect(await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } })).toMatchObject(
      { pending: false, reconciliationState: "complete" },
    );
  });
  it.each([false, true])(
    "returns a definitively rejected hold even across a receipt crash (crash=%s)",
    async (crash) => {
      const f = await fixture();
      await recordUsage(prisma, { ...f.event, costUsd: null, costSource: null }, f);
      const rejected = {
        ...f.usage,
        providerRequestId: null,
        costUsd: 0,
        costSource: "provider-rejection",
        usageSource: "provider-rejected",
      };
      if (crash)
        await prisma.modelCreditEntry.update({
          where: { callId: f.callId },
          data: { usage: JSON.parse(JSON.stringify(rejected)) },
        });
      else {
        await recordModelCreditReceipt(prisma, f.callId, rejected);
        expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(10_000_000n);
      }
      const reconcile = createModelCreditReconciler({
        prisma,
        now: () => new Date(Date.now() + 10 * 60_000),
      });
      await reconcile();
      await reconcile();
      expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(10_000_000n);
      expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
        costUsd: 0,
        usageSource: "provider-rejected",
      });
      expect(
        await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } }),
      ).toMatchObject({ pending: false, reconciliationState: "complete" });
    },
  );
  it("keeps both the estimate and authoritative correction in the journal", async () => {
    const f = await fixture();
    await recordModelCreditReceipt(prisma, f.callId, {
      ...f.usage,
      costUsd: 0.5,
      costSource: "pi-catalog-estimate",
    });
    await recordUsage(prisma, { ...f.event, costUsd: 0.5, costSource: "pi-catalog-estimate" }, f);
    await createModelCreditReconciler({
      prisma,
      lookup: { provider: "openrouter", lookupUsage: async () => f.usage },
      now: () => new Date(Date.now() + 10 * 60_000),
    })();
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    const events = await prisma.billingAuditEvent.findMany({
      where: { callId: f.callId, kind: { in: ["usage", "usage_correction", "correction"] } },
    });
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["usage", "usage_correction", "correction"]),
    );
    expect(
      (await prisma.usageRecord.findUniqueOrThrow({ where: { callId: f.callId } })).costSource,
    ).toBe("provider-reported");
  });
  it("does not rewrite an existing estimate when provider reconciliation has no new evidence", async () => {
    const f = await fixture();
    const estimate = { ...f.usage, costUsd: 0.5, costSource: "pi-catalog-estimate" };
    await recordModelCreditReceipt(prisma, f.callId, estimate);
    await recordUsage(prisma, { ...f.event, ...estimate }, f);
    const before = await prisma.billingAuditEvent.count({ where: { callId: f.callId } });
    await createModelCreditReconciler({
      prisma,
      lookup: { provider: "openrouter", lookupUsage: async () => null },
      now: () => new Date(Date.now() + 10 * 60_000),
    })();
    expect(await prisma.billingAuditEvent.count({ where: { callId: f.callId } })).toBe(before + 2);
    expect(await prisma.usageRecord.count({ where: { callId: f.callId } })).toBe(1);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_500_000n);
  });
  it("corrects every mutable usage bucket and preserves the original pricing evidence", async () => {
    const f = await fixture();
    await recordUsage(
      prisma,
      {
        ...f.event,
        costUsd: 0.5,
        costSource: "pi-catalog-estimate",
        cacheWrite1hTokens: 9,
        pricingSnapshot: { input: 2 },
      },
      f,
    );
    await recordUsage(
      prisma,
      { ...f.event, cacheWrite1hTokens: 3, pricingSnapshot: { input: 1 } },
      f,
      true,
    );
    expect(
      await prisma.usageRecord.findUniqueOrThrow({ where: { callId: f.callId } }),
    ).toMatchObject({ cacheWrite1hTokens: 3, pricingSnapshot: { input: 1 } });
    const original = await prisma.billingAuditEvent.findFirstOrThrow({
      where: { callId: f.callId, kind: "usage" },
    });
    expect(original.details).toMatchObject({
      cacheWrite1hTokens: 9,
      pricingSnapshot: { input: 2 },
    });
  });
  it("journals partial refunds as inverse deltas and never re-credits a replayed purchase", async () => {
    const f = await fixture();
    const purchase = await prisma.modelCreditEntry.findFirstOrThrow({
      where: { organizationId: f.organizationId, source: { startsWith: "purchase:" } },
    });
    const id = purchase.source.slice("purchase:".length);
    await reconcileCreditPurchase(prisma, f.organizationId, { id, amountCents: 500 });
    await reconcileCreditPurchase(prisma, f.organizationId, { id, amountCents: 1000 });
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(3_000_000n);
    const events = await prisma.billingAuditEvent.findMany({
      where: { organizationId: f.organizationId },
    });
    expect(events.filter((e) => e.kind === "refund").map((e) => e.amountMicros)).toEqual([
      -5_000_000n,
    ]);
    expect(events.reduce((sum, e) => sum + e.amountMicros, 0n)).toBe(3_000_000n);
  });
  it("releases the hold of a call that never reported back once retries run out", async () => {
    const f = await fixture();
    let now = Date.now() + 10 * 60_000;
    const reconcile = createModelCreditReconciler({ prisma, now: () => new Date(now) });
    for (let i = 0; i < 6; i++) {
      await reconcile();
      now += 60 * 60_000;
    }
    expect(await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } })).toMatchObject(
      { pending: false, reconciliationState: "complete" },
    );
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(10_000_000n);
  });
  it("replaces a released hold with the real usage of a call that outlived the reconciler", async () => {
    const f = await fixture();
    let now = Date.now() + 10 * 60_000;
    const reconcile = createModelCreditReconciler({ prisma, now: () => new Date(now) });
    for (let i = 0; i < 6; i++) {
      await reconcile();
      now += 60 * 60_000;
    }
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(10_000_000n);
    await recordModelCreditReceipt(prisma, f.callId, f.usage);
    await recordUsage(prisma, f.event, f);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
      costUsd: 0.25,
      costSource: "provider-reported",
    });
  });
  it("keeps real usage that lands before the reconciler's fallback", async () => {
    const f = await fixture();
    await recordModelCreditReceipt(prisma, f.callId, f.usage);
    await recordUsage(prisma, f.event, f);
    await recordUsage(
      prisma,
      { ...f.event, costUsd: 0, costSource: "reconciled-estimate", providerRequestId: null },
      f,
      true,
    );
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_750_000n);
    expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
      costUsd: 0.25,
      costSource: "provider-reported",
    });
  });
  it("finalizes a recorded estimate instead of replacing it with the fallback", async () => {
    const f = await fixture();
    const estimate = { ...f.usage, costUsd: 0.5, costSource: "pi-catalog-estimate" };
    await recordModelCreditReceipt(prisma, f.callId, estimate);
    await recordUsage(prisma, { ...f.event, ...estimate }, f);
    await recordUsage(
      prisma,
      { ...f.event, costUsd: 0, costSource: "reconciled-estimate", providerRequestId: null },
      f,
      true,
    );
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_500_000n);
    expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
      costUsd: 0.5,
      costSource: "reconciled-estimate",
    });
    expect(await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } })).toMatchObject(
      { pending: false, reconciliationState: "complete" },
    );
  });
  it("charges a stopped call for its counted tokens when the provider has no record", async () => {
    const f = await fixture();
    await recordModelCreditReceipt(prisma, f.callId, {
      providerRequestId: f.usage.providerRequestId,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      pricingSnapshot: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      countedTokens: { inputTokens: 100_000, outputTokens: 2_000 },
    });
    let now = Date.now() + 10 * 60_000;
    const reconcile = createModelCreditReconciler({
      prisma,
      lookup: { provider: "openrouter", lookupUsage: async () => null },
      now: () => new Date(now),
    });
    for (let i = 0; i < 6; i++) {
      await reconcile();
      now += 60 * 60_000;
    }
    expect(await prisma.modelCreditEntry.findUnique({ where: { callId: f.callId } })).toMatchObject(
      { pending: false, reconciliationState: "complete" },
    );
    expect(await prisma.usageRecord.findUnique({ where: { callId: f.callId } })).toMatchObject({
      costUsd: 0.04,
      costSource: "reconciled-estimate",
    });
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(9_960_000n);
  });
  it("retains usage and immutable journal history after organization deletion", async () => {
    const f = await fixture();
    await recordUsage(prisma, f.event, f);
    const before = await prisma.billingAuditEvent.count({
      where: { organizationId: f.organizationId },
    });
    await prisma.organization.delete({ where: { id: f.organizationId } });
    expect(await prisma.usageRecord.count({ where: { callId: f.callId } })).toBe(1);
    expect(
      await prisma.billingAuditEvent.count({ where: { organizationId: f.organizationId } }),
    ).toBe(before + 1);
    const event = await prisma.billingAuditEvent.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    });
    await expect(
      prisma.billingAuditEvent.update({ where: { id: event.id }, data: { kind: "tampered" } }),
    ).rejects.toThrow();
    await expect(prisma.billingAuditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });
  it("rebuilds a drifted balance from the journal with a durable repair event", async () => {
    const f = await fixture();
    await prisma.modelCreditAccount.update({
      where: { organizationId: f.organizationId },
      data: { balanceMicros: 99n },
    });
    const reconcile = createModelCreditReconciler({ prisma });
    // Other fixtures can precede this wallet in the bounded cursor.
    for (let i = 0; i < 10; i++) await reconcile();
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(8_000_000n);
    expect(
      await prisma.billingAuditEvent.count({
        where: { organizationId: f.organizationId, kind: "balance_rebuilt" },
      }),
    ).toBe(1);
    await prisma.modelCreditAccount.update({
      where: { organizationId: f.organizationId },
      data: { balanceMicros: 99n },
    });
    const retry = createModelCreditReconciler({ prisma });
    for (let i = 0; i < 10; i++) await retry();
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(8_000_000n);
    expect(
      await prisma.billingAuditEvent.count({
        where: { organizationId: f.organizationId, kind: "balance_rebuilt" },
      }),
    ).toBe(2);
  });
});

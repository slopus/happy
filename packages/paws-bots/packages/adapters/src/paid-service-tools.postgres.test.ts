import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, creditAccount, reconcileCreditPurchase } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serviceCallFromTool } from "./paid-service-tools.js";
import { FakePaidServiceProvider } from "./paid-services-factory.js";

const context = { signal: new AbortController().signal } as AdapterContext;
const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("paid service billing", () => {
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
  async function fixture(amountCents: number) {
    const id = `services-${process.pid}-${crypto.randomUUID()}`;
    const organizationId = `${id}-org`,
      userId = `${id}-user`,
      spaceId = `${id}-space`;
    fixtures.push({ organizationId, userId });
    await prisma.user.create({
      data: { id: userId, name: "Services fixture", email: `${id}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Services fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.member.create({
      data: { id: `${id}-member`, organizationId, userId, role: "owner", createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Services fixture" } });
    await creditAccount(prisma, organizationId);
    await prisma.modelCreditAccount.update({
      where: { organizationId },
      data: { mode: "credits" },
    });
    if (amountCents)
      await reconcileCreditPurchase(prisma, organizationId, { id: `${id}-purchase`, amountCents });
    return { organizationId, scope: { userId, spaceId, runId: `${id}-run`, botId: `${id}-bot` } };
  }

  it("charges the provider's cost plus the markup exactly once across a replay", async () => {
    const f = await fixture(100);
    const provider = new FakePaidServiceProvider();
    const deps = { prisma, provider, billing: true };
    const args = {
      service: "people.email",
      query: { full_name: "Ada", domain: "example.test" },
      max_cost_usd: 0.05,
    };
    await serviceCallFromTool(deps, f.scope, args, "effect-1", context);
    await serviceCallFromTool(deps, f.scope, args, "effect-1", context);
    expect((await creditAccount(prisma, f.organizationId)).balanceMicros).toBe(1_000_000n - 6_000n);
    const usage = await prisma.usageRecord.findMany({ where: { spaceId: f.scope.spaceId } });
    expect(usage).toEqual([
      expect.objectContaining({ provider: "services", model: "people.email", costUsd: 0.006 }),
    ]);
    const entry = await prisma.modelCreditEntry.findFirst({
      where: { organizationId: f.organizationId, provider: "services" },
    });
    expect(entry).toMatchObject({ pending: false, reconciliationState: "complete" });
  });

  it("refuses a call the organization cannot cover, without calling the provider", async () => {
    const f = await fixture(0);
    const provider = new FakePaidServiceProvider();
    const result = await serviceCallFromTool(
      { prisma, provider, billing: true },
      f.scope,
      { service: "people.email", max_cost_usd: 0.05 },
      "effect-2",
      context,
    );
    expect(result).toEqual({
      error: "Not enough credits for this service. Add credits in Billing.",
    });
    expect(provider.calls).toHaveLength(0);
  });
});

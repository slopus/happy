import type { ProductAnalytics } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor, AnalyticsEvent } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService, TRIAL_DAYS } from "./billing.js";
import { createExperiments } from "./experiments.js";

const experiments = createExperiments("plan-layout");
const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("plan choice funnel", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `funnel-owner-${stamp}`,
    organizationId = `funnel-org-${stamp}`,
    spaceId = `funnel-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `funnel-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `funnel-${stamp}` });
  const events: AnalyticsEvent[] = [];
  const identities: Array<string | undefined> = [];
  const analytics: ProductAnalytics = {
    capture: (captured, event, identity) => {
      expect(captured).toBe(userId);
      events.push(event);
      identities.push(identity?.id);
    },
    flush: async () => {},
  };
  let prisma: PrismaClient,
    db: ReturnType<typeof createDb>,
    service: ReturnType<typeof createBillingService>;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    const createdAt = new Date();
    await prisma.user.create({
      data: { id: userId, name: "Demo owner", email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Funnel fixture", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id: `member-${stamp}`, organizationId, userId, role: "owner", createdAt },
    });
    service = createBillingService({
      prisma,
      provider,
      experiments,
      webOrigin: "https://example.test",
      analytics,
    });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("lays out the plan choice the same way on every read", async () => {
    const first = await service.status(actor);
    expect(first.planLayout).toBe(experiments.variant("plan-layout", organizationId));
    await expect(service.status(actor)).resolves.toMatchObject({ planLayout: first.planLayout });
  });

  it("reports the chosen tier from checkout through the end of its trial, once each", async () => {
    await service.purchaseCredits(actor, { amountCents: 3000, monthly: true });
    await service.selectFunding(actor, "byok", undefined, "year", "pro");
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    expect(provider.byokCheckouts.get(customer)).toMatchObject({
      tier: "pro",
      interval: "year",
      trialDays: TRIAL_DAYS,
    });
    const terms = {
      plan: "own_key",
      tier: "pro",
      interval: "year",
      amountCents: BYOK_TIERS.pro.annualPriceCents,
    } as const;
    const subscriptionId = provider.completeByokCheckout(customer);
    // The first payment is still pending when the checkout returns.
    provider.setStatus(customer, "incomplete");
    await service.sync(customer);
    provider.setStatus(customer, "trialing");
    await service.sync(customer);
    await service.sync(customer);
    provider.setStatus(customer, "active");
    await service.sync(customer);
    await service.sync(customer);
    expect(events).toEqual([
      { name: "checkout_opened", plan: "credits", interval: "month", amountCents: 3000 },
      { name: "checkout_opened", ...terms },
      { name: "subscription_started", ...terms, trial: true },
      { name: "trial_ended", ...terms, converted: true },
    ]);
    // The analytics provider deduplicates lifecycle events that concurrent syncs both report.
    expect(identities).toEqual([undefined, undefined, subscriptionId, subscriptionId]);
    // A returning subscriber is not part of the layout comparison.
    expect((await service.status(actor)).planLayout).toBeUndefined();
  });
});

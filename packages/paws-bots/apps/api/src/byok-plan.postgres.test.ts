import type { SandboxProvider } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import { BillingEmulator, sandboxAllowance } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  createDb,
  planComputerSize,
  spaceHasModelAccess,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

// Computer use is read from runs and deployment settings that other suites share; tests set it.
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  sandboxAllowance: vi.fn(async () => null),
}));

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("own-key plan", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `byok-owner-${stamp}`,
    organizationId = `byok-org-${stamp}`,
    spaceId = `byok-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `byok-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `byok-${stamp}` });
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
      data: { id: organizationId, name: "Own-key fixture", slug: organizationId, createdAt },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id: `member-${stamp}`, organizationId, userId, role: "owner", createdAt },
    });
    service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
  });
  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("stays free without a checkout during the free period", async () => {
    const freeUntil = new Date(Date.now() + 86_400_000);
    await prisma.modelCreditAccount.create({
      data: { organizationId, mode: "byok", byokFreeUntil: freeUntil },
    });
    await expect(service.selectFunding(actor, "byok")).resolves.toEqual({ ok: true });
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      byokFreeUntil: freeUntil.toISOString(),
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
    expect(await billingAccountForOrganization(prisma, organizationId)).toBeNull();
  });

  it("loses access when the free period ends", async () => {
    await prisma.modelCreditAccount.update({
      where: { organizationId },
      data: { byokFreeUntil: new Date(Date.now() - 1000) },
    });
    await expect(service.status(actor)).resolves.toMatchObject({
      access: false,
      byokFreeUntil: null,
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(false);
  });

  it("grants access once the plan is paid", async () => {
    const { url } = await service.checkout(actor);
    expect(url).toContain("/byok/");
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    // The free period was this organization's trial.
    expect(provider.byokCheckouts.get(customer)?.trialDays).toBeUndefined();
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "byok",
      state: "active",
      balanceUsd: 0,
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
    await expect(service.checkout(actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps showing the price the plan was bought at after the price changes", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    const plan = provider.subscriptions.find((subscription) => subscription.byokPlan)!;
    expect(plan.byokPriceCents).toBe(BYOK_TIERS.standard.monthlyPriceCents);
    // Bought before the price rose.
    plan.byokPriceCents = BYOK_TIERS.standard.monthlyPriceCents! - 500;
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      byokPriceCents: BYOK_TIERS.standard.monthlyPriceCents! - 500,
    });
  });

  it("ends the plan at renewal once monthly credits start", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      funding: "credits",
      monthlyAmountCents: 2000,
    });
    expect(
      provider.subscriptions.find((subscription) => !subscription.creditAmountCents),
    ).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("switches to the plan when its payment syncs, without the checkout return", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "credits",
    });
    await expect(service.selectFunding(actor, "byok")).resolves.toMatchObject({
      url: expect.stringContaining("/byok/"),
    });
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "credits" });
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "byok", access: true });
  });

  it("ends the plan when monthly credits start already set not to renew", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    provider.subscriptions.at(-1)!.cancelAtPeriodEnd = true;
    await service.sync(customer);
    expect(
      provider.subscriptions.find(
        (subscription) => subscription.byokPlan && subscription.status === "active",
      ),
    ).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("bills the yearly plan at the yearly price and shows it as yearly", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      byokPriceCents: BYOK_TIERS.standard.monthlyPriceCents,
      byokInterval: "month",
      byokAnnualPriceCents: BYOK_TIERS.standard.annualPriceCents,
    });
    await service.selectFunding(actor, "byok", undefined, "year");
    expect(provider.byokCheckouts.get(customer)).toMatchObject({
      amountCents: BYOK_TIERS.standard.annualPriceCents,
      interval: "year",
    });
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "byok",
      byokPriceCents: BYOK_TIERS.standard.annualPriceCents,
      byokInterval: "year",
    });
  });

  it("switches a paid monthly plan to yearly, once", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await service.selectFunding(actor, "byok");
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({ byokInterval: "month" });
    // A subscriber on an older, cheaper monthly price would pay more by switching.
    const plan = provider.subscriptions.at(-1)!;
    plan.byokPriceCents = 1000;
    await expect(service.switchToYearly(actor)).rejects.toMatchObject({ code: "CONFLICT" });
    plan.byokPriceCents = BYOK_TIERS.standard.monthlyPriceCents!;
    // An overdue month must not be credited against the year.
    plan.status = "past_due";
    await expect(service.switchToYearly(actor)).rejects.toMatchObject({ code: "CONFLICT" });
    plan.status = "active";
    await service.switchToYearly(actor);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      byokPriceCents: BYOK_TIERS.standard.annualPriceCents,
      byokInterval: "year",
    });
    await expect(service.switchToYearly(actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("subscribes to a tier and moves between tiers at the same interval", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      byokTier: "standard",
      byokTiers: [
        { tier: "standard", monthlyPriceCents: 1500, computerSize: "standard", computerHours: 25 },
        { tier: "pro", monthlyPriceCents: 4900, computerSize: "large", computerHours: 100 },
        { tier: "max", monthlyPriceCents: 9900, computerSize: "xlarge", computerHours: 200 },
      ],
    });
    await service.checkout(actor, undefined, "year", "pro");
    expect(provider.byokCheckouts.get(customer)).toMatchObject({
      amountCents: BYOK_TIERS.pro.annualPriceCents,
      interval: "year",
      tier: "pro",
    });
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      byokTier: "pro",
      byokPriceCents: BYOK_TIERS.pro.annualPriceCents,
      byokInterval: "year",
    });
    expect(await planComputerSize(prisma, spaceId)).toBe("large");

    await expect(service.changeTier(actor, "pro")).rejects.toMatchObject({ code: "CONFLICT" });
    await service.changeTier(actor, "max");
    await expect(service.status(actor)).resolves.toMatchObject({
      byokTier: "max",
      byokPriceCents: BYOK_TIERS.max.annualPriceCents,
      byokInterval: "year",
    });
    expect(await planComputerSize(prisma, spaceId)).toBe("xlarge");
    await service.changeTier(actor, "standard");
    await expect(service.status(actor)).resolves.toMatchObject({
      byokTier: "standard",
      byokPriceCents: BYOK_TIERS.standard.annualPriceCents,
    });
    expect(await planComputerSize(prisma, spaceId)).toBe("standard");

    // A plan set to cancel stays as it is.
    provider.subscriptions.at(-1)!.cancelAtPeriodEnd = true;
    await expect(service.changeTier(actor, "pro")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("moves to a smaller tier only once this month's computer use fits it", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    for (const subscription of provider.subscriptions) subscription.status = "canceled";
    await service.sync(customer);
    await service.checkout(actor, undefined, "month", "max");
    provider.completeByokCheckout(customer);
    provider.subscriptions.at(-1)!.status = "active";
    const metered = createBillingService({
      prisma,
      provider,
      sandbox: {} as SandboxProvider,
      webOrigin: "https://example.test",
    });
    // $25 of computer time, more than Pro's $20 a month.
    vi.mocked(sandboxAllowance).mockResolvedValue({
      limitMicros: 40_000_000,
      usedMicros: 25_000_000,
      resetsAt: null,
    });
    await expect(metered.changeTier(actor, "pro")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(metered.changeTier(actor, "standard")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    vi.mocked(sandboxAllowance).mockResolvedValue({
      limitMicros: 40_000_000,
      usedMicros: 15_000_000,
      resetsAt: null,
    });
    await metered.changeTier(actor, "pro");
    await expect(metered.status(actor)).resolves.toMatchObject({ byokTier: "pro" });
    vi.mocked(sandboxAllowance).mockResolvedValue(null);
  });
});

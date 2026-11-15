import { BillingPaymentNotCompletedError } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingService, TRIAL_DAYS } from "./billing.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("model credit billing service", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `credit-owner-${stamp}`,
    organizationId = `credit-org-${stamp}`,
    spaceId = `credit-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `credit-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `credits-${stamp}` });
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
      data: { id: organizationId, name: "Credits fixture", slug: organizationId, createdAt },
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
  it("does not accept payment when managed models are unavailable", async () => {
    const unavailable = createBillingService({
      prisma,
      provider,
      webOrigin: "https://example.test",
      managedModelsAvailable: false,
    });
    await expect(unavailable.status(actor)).resolves.toMatchObject({
      creditPurchasesEnabled: false,
    });
    await expect(
      unavailable.purchaseCredits(actor, { amountCents: 2000, monthly: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(provider.creditCheckouts.size).toBe(0);
    expect(await billingAccountForOrganization(prisma, organizationId)).toBeNull();
  });
  it("starts with a funding choice, and BYOK opens the plan checkout with a trial", async () => {
    await expect(service.status(actor)).resolves.toMatchObject({
      access: false,
      funding: null,
      balanceUsd: 0,
      trialAvailable: true,
      trialDays: TRIAL_DAYS,
    });
    await expect(service.selectFunding(actor, "byok")).resolves.toMatchObject({
      url: expect.stringContaining("/byok/"),
    });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    expect(provider.byokCheckouts.get(customer)?.trialDays).toBe(TRIAL_DAYS);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: false,
      funding: null,
      byokPriceCents: BYOK_TIERS.standard.monthlyPriceCents,
      byokFreeUntil: null,
    });
  });
  it("does not grant credits for checkout creation, grants a paid monthly invoice once", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: true });
    await expect(service.status(actor)).resolves.toMatchObject({ funding: null, balanceUsd: 0 });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    await service.sync(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      funding: "credits",
      balanceUsd: 20,
      monthlyAmountCents: 2000,
      state: "active",
      trialAvailable: false,
    });
  });
  it("adds one-time topups without adding a second subscription", async () => {
    await service.purchaseCredits(actor, { amountCents: 2000, monthly: false });
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.completeCreditCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      balanceUsd: 40,
      monthlyAmountCents: 2000,
    });
    expect(provider.subscriptions).toHaveLength(1);
  });
  it("funds an upgrade immediately and changes the monthly allocation", async () => {
    await service.setMonthlyCredits(actor, 5000);
    await expect(service.status(actor)).resolves.toMatchObject({
      balanceUsd: 70,
      monthlyAmountCents: 5000,
    });
  });
  it("applies a lower monthly allocation at renewal without removing existing credits", async () => {
    await service.setMonthlyCredits(actor, 2000);
    await expect(service.status(actor)).resolves.toMatchObject({
      balanceUsd: 70,
      monthlyAmountCents: 2000,
    });
  });
  it("requires canceling a recurring plan before choosing the free funding path", async () => {
    await expect(service.selectFunding(actor, "byok")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "credits" });
  });
  it("preserves an explicit BYOK choice when another monthly credit grant arrives", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.subscriptions[0]!.cancelAtPeriodEnd = true;
    await service.sync(customer);
    await service.selectFunding(actor, "byok");
    provider.creditPurchases.get(customer)!.push({ id: `renewal-${stamp}`, amountCents: 2000 });
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({ funding: "byok", balanceUsd: 90 });
  });
  it("reactivates existing credits without another checkout or removing a personal connection", async () => {
    const connection = await prisma.userModelCredential.create({
      data: { userId, provider: "openai", label: "Personal fixture", secretId: "fixture-secret" },
    });
    const before = await service.status(actor);
    const checkouts = provider.creditCheckouts.size;
    await service.selectFunding(actor, "credits");
    await expect(service.status(actor)).resolves.toMatchObject({
      funding: "credits",
      balanceUsd: before.balanceUsd,
    });
    expect(provider.creditCheckouts.size).toBe(checkouts);
    expect(await prisma.userModelCredential.findUnique({ where: { id: connection.id } })).toEqual(
      connection,
    );
  });
  it("refuses purchasing and changing plans without organization ownership", async () => {
    const other = { ...actor, userId: `non-member-${stamp}` };
    await expect(
      service.purchaseCredits(other, { amountCents: 2000, monthly: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.setMonthlyCredits(other, 2000)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("answers a change to an ended monthly plan as a conflict and resyncs the plan", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.setStatus(customer, "canceled");
    await expect(service.setMonthlyCredits(actor, 5000)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(service.status(actor)).resolves.toMatchObject({ state: "canceled" });
  });
  it("answers payment required when the card is not charged for an upgrade", async () => {
    vi.spyOn(provider, "setMonthlyCredits").mockRejectedValueOnce(
      new BillingPaymentNotCompletedError(),
    );
    await expect(service.setMonthlyCredits(actor, 5000)).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      status: 402,
    });
  });
});

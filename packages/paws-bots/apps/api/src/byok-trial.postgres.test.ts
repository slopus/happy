import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb, spaceHasModelAccess } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService, TRIAL_DAYS } from "./billing.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("own-key trial", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `trial-owner-${stamp}`,
    organizationId = `trial-org-${stamp}`,
    spaceId = `trial-space-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `trial-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const provider = new BillingEmulator({ modelCredits: true, namespace: `trial-${stamp}` });
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
      data: { id: organizationId, name: "Trial fixture", slug: organizationId, createdAt },
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

  it("grants access during the trial", async () => {
    await service.selectFunding(actor, "byok", "mobile");
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    // Opened from the app, checkout returns through the API to close the in-app browser.
    expect(provider.byokCheckouts.get(customer)).toMatchObject({
      trialDays: TRIAL_DAYS,
      successUrl: "https://example.test/api/v1/billing/return?client=mobile",
      cancelUrl: "https://example.test/api/v1/billing/return?client=mobile",
    });
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "byok",
      state: "trialing",
      trialEndsAt: expect.any(String),
      trialAvailable: false,
    });
    await expect(spaceHasModelAccess(prisma, spaceId)).resolves.toBe(true);
  });

  it("offers no second trial after the first one is canceled", async () => {
    const customer = (await billingAccountForOrganization(prisma, organizationId))!.customerId;
    provider.setStatus(customer, "canceled");
    await service.sync(customer);
    await expect(service.status(actor)).resolves.toMatchObject({
      access: false,
      trialAvailable: false,
    });
    await service.selectFunding(actor, "byok");
    expect(provider.byokCheckouts.get(customer)?.trialDays).toBeUndefined();
  });
});

import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService, INVITED_TRIAL_DAYS, TRIAL_DAYS } from "./billing.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("referrals", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const webOrigin = "https://example.test";
  const provider = new BillingEmulator({ modelCredits: true, namespace: `referrals-${stamp}` });
  const organizations: string[] = [];
  const users: string[] = [];
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof createBillingService>;

  async function newOrganization(name: string): Promise<Actor & { organizationId: string }> {
    const id = `referral-${name}-${stamp}`;
    const createdAt = new Date();
    const email = `${id}@rakazo.test`;
    await prisma.user.create({ data: { id, name, email, emailVerified: false } });
    await prisma.organization.create({ data: { id, name, slug: id, createdAt } });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    organizations.push(id);
    users.push(id);
    return { userId: id, spaceId: id, email, isDeploymentOwner: false, organizationId: id };
  }

  async function startTrial(actor: Actor & { organizationId: string }, card?: string) {
    await service.selectFunding(actor, "byok");
    const { customerId } = (await billingAccountForOrganization(prisma, actor.organizationId))!;
    provider.completeByokCheckout(customerId, card);
    await service.sync(customerId);
    return customerId;
  }

  async function inviteCode(actor: Actor) {
    const referral = (await service.status(actor)).referral;
    return new URL(referral!.url).searchParams.get("ref")!;
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    service = createBillingService({ prisma, provider, webOrigin });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("offers every owner the same invite link before they subscribe", async () => {
    const referrer = await newOrganization("early");
    const { referral } = await service.status(referrer);
    expect(referral).toEqual({
      url: expect.stringMatching(`^${webOrigin}/sign-up\\?ref=`),
      rewards: 0,
    });
    await expect(service.status(referrer)).resolves.toMatchObject({ referral });
  });

  it("gives an invited friend a longer first trial and everyone else the usual one", async () => {
    const referrer = await newOrganization("trial-referrer");
    const friend = await newOrganization("trial-friend");
    const stranger = await newOrganization("trial-stranger");
    await service.claimReferral(friend, await inviteCode(referrer));
    await expect(service.status(friend)).resolves.toMatchObject({ trialDays: INVITED_TRIAL_DAYS });
    await expect(service.status(stranger)).resolves.toMatchObject({ trialDays: TRIAL_DAYS });
    for (const [actor, days] of [
      [friend, INVITED_TRIAL_DAYS],
      [stranger, TRIAL_DAYS],
    ] as const) {
      await service.selectFunding(actor, "byok");
      const { customerId } = (await billingAccountForOrganization(prisma, actor.organizationId))!;
      expect(provider.byokCheckouts.get(customerId)?.trialDays).toBe(days);
    }
  });

  it("ignores a code from another organization the claimer belongs to", async () => {
    const owner = await newOrganization("self-referrer");
    const second = await newOrganization("self-second");
    await prisma.member.create({
      data: {
        id: `${second.organizationId}-owner`,
        organizationId: second.organizationId,
        userId: owner.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    // The same person, acting in their second organization.
    const sameOwner = { ...owner, spaceId: second.spaceId, organizationId: second.organizationId };
    await service.claimReferral(sameOwner, await inviteCode(owner));
    await expect(service.status(second)).resolves.toMatchObject({ trialDays: TRIAL_DAYS });
  });

  it("still gifts the longer trial when two companies only share a teammate", async () => {
    const referrer = await newOrganization("shared-referrer");
    const friend = await newOrganization("shared-friend");
    const teammate = await newOrganization("shared-teammate");
    await prisma.member.createMany({
      data: [referrer, friend].map((org) => ({
        id: `${org.organizationId}-teammate`,
        organizationId: org.organizationId,
        userId: teammate.userId,
        role: "member",
        createdAt: new Date(),
      })),
    });
    await service.claimReferral(friend, await inviteCode(referrer));
    await expect(service.status(friend)).resolves.toMatchObject({ trialDays: INVITED_TRIAL_DAYS });
  });

  it("grants the referrer a free month when the friend starts a trial with a new card", async () => {
    const referrer = await newOrganization("referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    const friendCustomer = await startTrial(friend);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(
      BYOK_TIERS.standard.monthlyPriceCents,
    );
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(
      BYOK_TIERS.standard.monthlyPriceCents,
    );
    await expect(service.status(referrer)).resolves.toMatchObject({
      referral: { rewards: 1 },
    });
  });

  it("declines a friend paying with the referrer's own card or a card another referral used", async () => {
    const referrer = await newOrganization("self");
    const referrerCustomer = await startTrial(referrer, "shared-card");
    const code = await inviteCode(referrer);
    const sameCard = await newOrganization("same-card");
    await service.claimReferral(sameCard, code);
    await startTrial(sameCard, "shared-card");
    const first = await newOrganization("first");
    await service.claimReferral(first, code);
    await startTrial(first, "reused-card");
    const reused = await newOrganization("reused");
    await service.claimReferral(reused, code);
    await startTrial(reused, "reused-card");
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(
      BYOK_TIERS.standard.monthlyPriceCents,
    );
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 1 } });
  });

  it("extends the free period of a referrer who has not subscribed", async () => {
    const referrer = await newOrganization("free");
    const freeUntil = new Date(Date.now() + 5 * 86_400_000);
    await prisma.modelCreditAccount.create({
      data: { organizationId: referrer.organizationId, mode: "byok", byokFreeUntil: freeUntil },
    });
    const friend = await newOrganization("free-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    const friendCustomer = await startTrial(friend);
    await service.sync(friendCustomer);
    const credits = await prisma.modelCreditAccount.findUniqueOrThrow({
      where: { organizationId: referrer.organizationId },
    });
    expect(credits.byokFreeUntil!.getTime()).toBe(freeUntil.getTime() + 30 * 86_400_000);
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 1 } });
  });

  it("adds a month for each of two friends settling at the same time", async () => {
    const referrer = await newOrganization("concurrent");
    const code = await inviteCode(referrer);
    const friends = await Promise.all([
      newOrganization("concurrent-a"),
      newOrganization("concurrent-b"),
    ]);
    const customers: string[] = [];
    for (const friend of friends) {
      await service.claimReferral(friend, code);
      await service.selectFunding(friend, "byok");
      const { customerId } = (await billingAccountForOrganization(prisma, friend.organizationId))!;
      provider.completeByokCheckout(customerId);
      customers.push(customerId);
    }
    const before = Date.now();
    await Promise.all(customers.map((customerId) => service.sync(customerId)));
    const credits = await prisma.modelCreditAccount.findUniqueOrThrow({
      where: { organizationId: referrer.organizationId },
    });
    expect(credits.byokFreeUntil!.getTime()).toBeGreaterThanOrEqual(before + 60 * 86_400_000);
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 2 } });
  });

  it("finishes a reward a restart interrupted without granting it twice", async () => {
    const referrer = await newOrganization("restart-referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("restart-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    const friendCustomer = await startTrial(friend);
    await prisma.referral.update({
      where: { organizationId: friend.organizationId },
      data: { rewardedAt: null },
    });
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(
      BYOK_TIERS.standard.monthlyPriceCents,
    );
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 1 } });
  });

  it("finishes an approved reward the same way after the referrer changes funding", async () => {
    const referrer = await newOrganization("decided-referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("decided-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    await service.selectFunding(friend, "byok");
    const friendCustomer = (await billingAccountForOrganization(prisma, friend.organizationId))!
      .customerId;
    provider.completeByokCheckout(friendCustomer, "decided-card");
    await prisma.referral.update({
      where: { organizationId: friend.organizationId },
      data: { outcome: "balance", cardFingerprint: "decided-card" },
    });
    await prisma.modelCreditAccount.update({
      where: { organizationId: referrer.organizationId },
      data: { mode: "credits" },
    });
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(
      BYOK_TIERS.standard.monthlyPriceCents,
    );
    await expect(service.status(referrer)).resolves.toMatchObject({
      balanceUsd: 0,
      referral: { rewards: 1 },
    });
  });

  it("ignores a claim after subscribing, for its own code, or for an unknown code", async () => {
    const referrer = await newOrganization("ignored");
    const referrerCustomer = await startTrial(referrer);
    const code = await inviteCode(referrer);
    await service.claimReferral(referrer, code);
    const late = await newOrganization("late");
    await startTrial(late);
    await service.claimReferral(late, code);
    const unknown = await newOrganization("unknown");
    await service.claimReferral(unknown, "not-a-code");
    expect(
      await prisma.referral.count({
        where: {
          organizationId: {
            in: [referrer.organizationId, late.organizationId, unknown.organizationId],
          },
        },
      }),
    ).toBe(0);
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
  });

  it("pays a credits referrer in model credits, which a balance credit would not add", async () => {
    const referrer = await newOrganization("credits");
    await service.purchaseCredits(referrer, { amountCents: 2000, monthly: true });
    const referrerCustomer = (await billingAccountForOrganization(prisma, referrer.organizationId))!
      .customerId;
    provider.completeCreditCheckout(referrerCustomer);
    await service.sync(referrerCustomer);
    const before = (await service.status(referrer)).balanceUsd!;
    const friend = await newOrganization("credits-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    await startTrial(friend);
    await expect(service.status(referrer)).resolves.toMatchObject({
      balanceUsd: before + BYOK_TIERS.standard.monthlyPriceCents! / 100,
      referral: { rewards: 1 },
    });
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
  });
});

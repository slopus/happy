import { randomUUID } from "node:crypto";
import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { BillingAccount, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";
import { IsolationError } from "./scope.js";

const ACCESS_STATUSES = new Set(["trialing", "active", "past_due"]);

export function hasBillingAccess(status: string | null): boolean {
  return status !== null && ACCESS_STATUSES.has(status);
}

/**
 * Whether a model-credit organization can run bots. Any live subscription grants it, as does a
 * credit balance outside own-key mode. Otherwise only a free own-key plan or free period does.
 */
export function hasModelAccess(
  credits: { mode: string | null; balanceMicros: bigint; byokFreeUntil: Date | null },
  subscriptionStatus: string | null,
  now = new Date(),
): boolean {
  if (hasBillingAccess(subscriptionStatus)) return true;
  if (credits.mode === "byok")
    return BYOK_TIERS.standard.monthlyPriceCents === null || byokFreeUntil(credits, now) !== null;
  if (credits.balanceMicros > 0n) return true;
  return BYOK_TIERS.standard.monthlyPriceCents === null && credits.mode === "credits";
}

/** The free period's end while it is still running. */
export function byokFreeUntil(credits: { byokFreeUntil: Date | null }, now = new Date()) {
  return credits.byokFreeUntil && credits.byokFreeUntil > now ? credits.byokFreeUntil : null;
}

export const FREE_MONTH_DAYS = 30;
/** How long an open checkout session holds the owner's trial; sessions live about a day. */
const BYOK_TRIAL_CHECKOUT_HOLD_MS = 24 * 60 * 60 * 1000;

/** One statement, so concurrent grants each add their days. */
export async function extendByokFreePeriod(
  tx: Prisma.TransactionClient,
  organizationId: string,
  days: number,
) {
  await tx.$executeRaw`
    UPDATE model_credit_accounts
    SET "byokFreeUntil" = GREATEST(COALESCE("byokFreeUntil", now()), now()) + make_interval(days => ${days}::int)
    WHERE "organizationId" = ${organizationId}`;
  // The free days are the owners' own-key trial, used even if the organization later goes away.
  await markOwnersByokTrialUsed(tx, { id: organizationId });
}

const SUBSCRIBED: Prisma.OrganizationWhereInput = {
  billing: { is: { subscribedAt: { not: null } } },
};
const HAD_FREE_DAYS: Prisma.OrganizationWhereInput = {
  modelCredits: { is: { byokFreeUntil: { not: null } } },
};

/** Survives the organization, so deleting it never earns its owner another trial. */
async function markOwnersTrialUsed(
  db: Pick<PrismaClient, "user"> | Prisma.TransactionClient,
  organization: Prisma.OrganizationWhereInput,
) {
  await db.user.updateMany({
    where: {
      billingTrialUsedAt: null,
      members: { some: { organization, role: { contains: "owner" } } },
    },
    data: { billingTrialUsedAt: new Date() },
  });
}

/** Free own-key days use up only the own-key trial, and survive the organization they belonged to. */
async function markOwnersByokTrialUsed(
  db: Pick<PrismaClient, "user"> | Prisma.TransactionClient,
  organization: Prisma.OrganizationWhereInput,
) {
  await db.user.updateMany({
    where: {
      byokTrialUsedAt: null,
      members: { some: { organization, role: { contains: "owner" } } },
    },
    data: { byokTrialUsedAt: new Date() },
  });
}

/** A hold one checkout attempt took on the owners' one own-key trial. */
export type ByokTrialCheckoutHold = {
  /** Identifies this attempt's hold, so giving it back cannot touch another session's. */
  expiresAt: Date;
};

/**
 * Takes the owners' one own-key trial for this organization's checkout session, so another
 * organization of theirs cannot take it while the session is open. The hold lasts as long as
 * the session can still be paid, and moving to the same organization's newest session renews
 * it. Returns null when a fresh hold for another organization wins the race.
 */
export async function reserveByokTrialCheckout(
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<ByokTrialCheckoutHold | null> {
  const owners = await prisma.member.findMany({
    where: { organizationId, role: { contains: "owner" } },
    select: { userId: true, role: true },
  });
  const ownerIds = owners.filter((owner) => isOwnerRole(owner.role)).map((owner) => owner.userId);
  if (ownerIds.length === 0) return null;
  const expiresAt = new Date(Date.now() + BYOK_TRIAL_CHECKOUT_HOLD_MS);
  const { count } = await prisma.user.updateMany({
    where: {
      id: { in: ownerIds },
      billingTrialUsedAt: null,
      byokTrialUsedAt: null,
      OR: [
        { byokTrialCheckoutOrganizationId: null },
        { byokTrialCheckoutOrganizationId: organizationId },
        { byokTrialCheckoutExpiresAt: { lte: new Date() } },
      ],
    },
    data: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: expiresAt,
    },
  });
  return count === ownerIds.length ? { expiresAt } : null;
}

/**
 * Gives back a hold `reserveByokTrialCheckout` returned once the provider refused to create
 * the session. A newer attempt's hold has another expiry and stays.
 */
export async function releaseByokTrialCheckout(
  prisma: PrismaClient,
  organizationId: string,
  hold: ByokTrialCheckoutHold,
): Promise<void> {
  await prisma.user.updateMany({
    where: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: hold.expiresAt,
    },
    data: { byokTrialCheckoutOrganizationId: null, byokTrialCheckoutExpiresAt: null },
  });
}

/** Moves the hold to the moment the session was created, which is when it starts expiring. */
export async function extendByokTrialCheckout(
  prisma: PrismaClient,
  organizationId: string,
  hold: ByokTrialCheckoutHold,
): Promise<void> {
  await prisma.user.updateMany({
    where: {
      byokTrialCheckoutOrganizationId: organizationId,
      byokTrialCheckoutExpiresAt: hold.expiresAt,
    },
    data: { byokTrialCheckoutExpiresAt: new Date(Date.now() + BYOK_TRIAL_CHECKOUT_HOLD_MS) },
  });
}

/** Releases every hold the organization's open checkout sessions had on their owners' trial. */
export async function releaseByokTrialCheckouts(
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await prisma.user.updateMany({
    where: { byokTrialCheckoutOrganizationId: organizationId },
    data: { byokTrialCheckoutOrganizationId: null, byokTrialCheckoutExpiresAt: null },
  });
}

const MODEL_ACCESS_SELECT = {
  modelCredits: { select: { mode: true, balanceMicros: true, byokFreeUntil: true } },
  billing: { select: { status: true } },
} as const;

function organizationModelAccess(organization: {
  modelCredits: { mode: string | null; balanceMicros: bigint; byokFreeUntil: Date | null } | null;
  billing: { status: string | null } | null;
}) {
  return hasModelAccess(
    organization.modelCredits ?? { mode: null, balanceMicros: 0n, byokFreeUntil: null },
    organization.billing?.status ?? null,
  );
}

export async function spaceHasModelAccess(prisma: PrismaClient, spaceId: string) {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { organization: { select: MODEL_ACCESS_SELECT } },
  });
  return space ? organizationModelAccess(space.organization) : false;
}

/** Access for one person's run: their own organization's plan when they are a guest. */
export async function memberHasModelAccess(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
) {
  // A member's org is the Space's, read with the membership in one query.
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
    select: { member: { select: { role: true, organization: { select: MODEL_ACCESS_SELECT } } } },
  });
  if (!membership) return false;
  if (membership.member.role !== GUEST_ROLE) {
    return organizationModelAccess(membership.member.organization);
  }
  const organization = await prisma.organization.findUnique({
    where: { id: await ownedOrganizationId(prisma, scope.userId) },
    select: MODEL_ACCESS_SELECT,
  });
  return organization ? organizationModelAccess(organization) : false;
}

export function billingAccountForOrganization(
  prisma: PrismaClient,
  organizationId: string,
): Promise<BillingAccount | null> {
  return prisma.billingAccount.findUnique({ where: { organizationId } });
}

/** Idempotent per organization: a concurrent create keeps the first stored customer. */
export async function createBillingAccount(
  prisma: PrismaClient,
  input: { organizationId: string; customerId: string },
): Promise<BillingAccount> {
  try {
    return await prisma.billingAccount.upsert({
      where: { organizationId: input.organizationId },
      create: input,
      update: {},
    });
  } catch (error) {
    // An empty update is not a native upsert, so a concurrent create can still collide.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existing = await billingAccountForOrganization(prisma, input.organizationId);
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Points the organization at a new customer after the provider deleted the old one, clearing the
 * old subscription snapshot but keeping `subscribedAt` so no second trial is offered. When a
 * concurrent request already swapped it, that swap wins. Returns the stored account.
 */
export async function replaceBillingCustomer(
  prisma: PrismaClient,
  input: { organizationId: string; previousCustomerId: string; customerId: string },
): Promise<BillingAccount> {
  await prisma.billingAccount.updateMany({
    where: { organizationId: input.organizationId, customerId: input.previousCustomerId },
    data: {
      customerId: input.customerId,
      creditAmountCents: null,
      byokPriceCents: null,
      byokInterval: null,
      byokTier: null,
      subscriptionId: null,
      subscriptionItemId: null,
      priceId: null,
      status: null,
      seats: null,
      trialEndsAt: null,
      currentPeriodStartsAt: null,
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
      endedAt: null,
      cancellationReason: null,
      cancellationComment: null,
      syncedAt: null,
    },
  });
  return prisma.billingAccount.findUniqueOrThrow({
    where: { organizationId: input.organizationId },
  });
}

/**
 * Claims the organization's checkout lease, coordinating API instances without holding a
 * connection over provider calls. Returns the lease id, or null while another request holds it.
 */
export async function claimCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  ttlMs: number,
): Promise<string | null> {
  const leaseId = randomUUID();
  const now = new Date();
  const { count } = await prisma.billingAccount.updateMany({
    where: {
      organizationId,
      OR: [{ checkoutLeaseExpiresAt: null }, { checkoutLeaseExpiresAt: { lte: now } }],
    },
    data: { checkoutLeaseId: leaseId, checkoutLeaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return count > 0 ? leaseId : null;
}

export async function releaseCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
): Promise<void> {
  await prisma.billingAccount.updateMany({
    where: { organizationId, checkoutLeaseId: leaseId },
    data: { checkoutLeaseId: null, checkoutLeaseExpiresAt: null },
  });
}

/**
 * Extends the lease while its holder is still the recorded owner and the lease has not lapsed;
 * a lapsed lease is left to the next claimant instead of being resurrected.
 */
export async function renewCheckoutLease(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.billingAccount.updateMany({
    where: {
      organizationId,
      checkoutLeaseId: leaseId,
      checkoutLeaseExpiresAt: { gt: now },
    },
    data: { checkoutLeaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return count > 0;
}

/**
 * Locks the lease row while this holder still has the checkout lease, so no other claimant
 * can take it until the transaction ends. Returns false once the lease is lost. Every lock
 * wait in the transaction is bounded, so a write stuck behind another lock fails and rolls
 * back instead of holding the lease row while renewals queue behind it.
 */
export async function lockCheckoutLease(
  tx: Prisma.TransactionClient,
  organizationId: string,
  leaseId: string,
): Promise<boolean> {
  // Row locks on these tables last milliseconds; 2s stays below Prisma's 5s transaction
  // timeout, which ends the transaction without cancelling a statement still waiting.
  await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '2s'`);
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
    SELECT 1 FROM billing_accounts
    WHERE "organizationId" = ${organizationId} AND "checkoutLeaseId" = ${leaseId}
      AND "checkoutLeaseExpiresAt" > ${new Date()}
    FOR UPDATE`);
  return rows.length > 0;
}

/** Whether `error` is a lock wait that ran past the bound `lockCheckoutLease` sets. */
export function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const meta = error.meta as { driverAdapterError?: { cause?: { originalCode?: string } } };
  return meta?.driverAdapterError?.cause?.originalCode === "55P03";
}

/** Whether the checkout lease is still recorded for this holder. */
export async function checkoutLeaseHeld(
  prisma: PrismaClient,
  organizationId: string,
  leaseId: string,
): Promise<boolean> {
  const held = await prisma.billingAccount.findFirst({
    where: { organizationId, checkoutLeaseId: leaseId },
    select: { organizationId: true },
  });
  return held !== null;
}

/** The subscription exists but has no access until the owner settles it in the billing portal. */
export function needsBillingPortal(status: string | null): boolean {
  return status === "unpaid" || status === "paused";
}

/**
 * Loads the customer's current subscription and overwrites the stored snapshot (`null` clears
 * it). The write only lands if no sync that started later has written first, so an older read
 * never replaces a newer one. Returns false when no account is stored for the customer.
 */
export async function syncBillingSnapshot(
  prisma: PrismaClient,
  customerId: string,
  load: () => Promise<BillingSubscriptionSnapshot | null>,
): Promise<boolean> {
  // The database clock, so API instances with skewed clocks still order correctly.
  const [{ startedAt }] = await prisma.$queryRaw<[{ startedAt: Date }]>(
    Prisma.sql`SELECT clock_timestamp() AS "startedAt"`,
  );
  const snapshot = await load();
  const written = await prisma.billingAccount.updateMany({
    where: { customerId, OR: [{ syncedAt: null }, { syncedAt: { lt: startedAt } }] },
    data: {
      creditAmountCents: snapshot?.creditAmountCents ?? null,
      byokPriceCents: snapshot?.byokPriceCents ?? null,
      byokInterval: snapshot?.byokInterval ?? null,
      byokTier: snapshot?.byokTier ?? null,
      subscriptionId: snapshot?.subscriptionId ?? null,
      subscriptionItemId: snapshot?.subscriptionItemId ?? null,
      priceId: snapshot?.priceId ?? null,
      status: snapshot?.status ?? null,
      seats: snapshot?.seats ?? null,
      trialEndsAt: snapshot?.trialEndsAt ?? null,
      currentPeriodStartsAt: snapshot?.currentPeriodStartsAt ?? null,
      currentPeriodEndsAt: snapshot?.currentPeriodEndsAt ?? null,
      cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
      endedAt: snapshot?.endedAt ?? null,
      cancellationReason: snapshot?.cancellationReason ?? null,
      cancellationComment: snapshot?.cancellationComment ?? null,
      syncedAt: startedAt,
    },
  });
  if (snapshot) {
    await prisma.billingAccount.updateMany({
      where: { customerId, subscribedAt: null },
      data: { subscribedAt: startedAt },
    });
    await markOwnersTrialUsed(prisma, { billing: { is: { customerId } } });
  }
  if (snapshot?.status === "active") {
    await prisma.billingAccount.updateMany({
      where: { customerId, paidAt: null },
      data: { paidAt: startedAt },
    });
  }
  if (written.count > 0) return true;
  return (await prisma.billingAccount.count({ where: { customerId } })) > 0;
}

/** Billable seats: every organization member but guests, never fewer than one. */
export async function organizationSeatCount(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  const members = await prisma.member.count({
    where: { organizationId, role: { not: GUEST_ROLE } },
  });
  return Math.max(1, members);
}

/** An organization that is not being deleted: its default Space is not being torn down. */
export const LIVE_ORGANIZATION: Prisma.OrganizationWhereInput = {
  spaces: { some: { isDefault: true, deletingAt: null } },
};

/** The org role of someone who belongs to an organization only through Spaces they were invited to. */
export const GUEST_ROLE = "guest";

/** The oldest organization the user owns that is not being deleted, where their own Spaces live. */
export async function ownedOrganizationId(
  db: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string> {
  const memberships = await db.member.findMany({
    where: {
      userId,
      organization: LIVE_ORGANIZATION,
    },
    select: { organizationId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  const owned = memberships.find((membership) => isOwnerRole(membership.role));
  if (!owned) throw new IsolationError();
  return owned.organizationId;
}

/**
 * The organization that pays for this person's work in a Space: the Space's own, or for a guest
 * their own oldest organization, so a shared Space never bills its owner for someone else.
 */
export async function organizationForMember(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string; isOwner: boolean } | null> {
  const space = await prisma.space.findUnique({
    where: { id: input.spaceId },
    select: { organizationId: true },
  });
  if (!space) return null;
  const member = await prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: space.organizationId, userId: input.userId },
    },
    select: { role: true },
  });
  if (!member) return null;
  if (member.role === GUEST_ROLE) {
    return { organizationId: await ownedOrganizationId(prisma, input.userId), isOwner: true };
  }
  return { organizationId: space.organizationId, isOwner: isOwnerRole(member.role) };
}

export async function ownedBillingAccounts(
  prisma: PrismaClient,
  userId: string,
): Promise<BillingAccount[]> {
  const memberships = await prisma.member.findMany({
    where: { userId, organization: { billing: { isNot: null } } },
    select: { role: true, organization: { select: { billing: true } } },
  });
  return memberships.flatMap((membership) =>
    isOwnerRole(membership.role) && membership.organization.billing
      ? [membership.organization.billing]
      : [],
  );
}

/** Before an organization's billing rows go, so a subscription that predates the user-level mark still counts. */
export async function keepOrganizationTrialUse(prisma: PrismaClient, organizationId: string) {
  await markOwnersTrialUsed(prisma, { id: organizationId, ...SUBSCRIBED });
  // Free own-key days granted before the owner-level mark existed also outlast the rows.
  await markOwnersByokTrialUsed(prisma, { id: organizationId, ...HAD_FREE_DAYS });
}

/**
 * One trial per person: any subscription uses it up. Free own-key days also use up the own-key
 * trial, but not the managed plan's, and so does another organization's still-open trial
 * checkout. Organizations that subscribed before the user-level mark existed still count, so
 * older accounts need no backfill.
 */
export async function ownerHadTrial(
  prisma: PrismaClient,
  userId: string,
  plan: "byok" | "managed",
  forOrganizationId?: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      billingTrialUsedAt: true,
      byokTrialUsedAt: true,
      byokTrialCheckoutOrganizationId: true,
      byokTrialCheckoutExpiresAt: true,
    },
  });
  if (user?.billingTrialUsedAt) return true;
  if (plan === "byok") {
    if (user?.byokTrialUsedAt) return true;
    // The owner's own open session keeps their trial available; another organization's holds it.
    if (
      user?.byokTrialCheckoutExpiresAt &&
      user.byokTrialCheckoutExpiresAt > new Date() &&
      user.byokTrialCheckoutOrganizationId !== forOrganizationId
    )
      return true;
  }
  const used = await prisma.member.findFirst({
    where: {
      userId,
      role: { contains: "owner" },
      organization: plan === "byok" ? { OR: [SUBSCRIBED, HAD_FREE_DAYS] } : SUBSCRIBED,
    },
    select: { id: true },
  });
  return used !== null;
}

/** Whether the organization's owner has used their one trial, whichever member is asking. */
export async function organizationOwnerHadTrial(
  prisma: PrismaClient,
  organizationId: string,
  plan: "byok" | "managed",
): Promise<boolean> {
  const members = await prisma.member.findMany({
    where: { organizationId, role: { contains: "owner" } },
    select: { userId: true, role: true },
  });
  for (const member of members) {
    if (
      isOwnerRole(member.role) &&
      (await ownerHadTrial(prisma, member.userId, plan, organizationId))
    )
      return true;
  }
  return false;
}

/** Better Auth stores roles as a comma-separated list. */
export function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}

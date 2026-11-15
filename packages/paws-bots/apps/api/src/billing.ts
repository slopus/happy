import { setTimeout as sleep } from "node:timers/promises";
import { ORPCError } from "@orpc/server";
import type {
  BillingByokPlan,
  BillingPrice,
  BillingProvider,
  BillingSubscriptionSnapshot,
  ProductAnalytics,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  BillingCheckoutCompletedError,
  BillingCustomerNotFoundError,
  BillingNoMonthlyCreditsError,
  BillingPaymentNotCompletedError,
} from "@rakazo/adapter-kit";
import { sandboxAllowance, sandboxHoursLeft } from "@rakazo/adapters";
import type {
  Actor,
  AnalyticsEvent,
  BillingStatus,
  ByokInterval,
  ByokTier,
} from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  byokTierPriceCents,
  INVITED_TRIAL_WEEKS,
  sandboxAllowanceHours,
  TRIAL_DAYS,
} from "@rakazo/contracts";
import type { BillingAccount, Prisma, PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  byokFreeUntil,
  checkoutLeaseHeld,
  claimCheckoutLease,
  createBillingAccount,
  creditAccount,
  expireModelCredits,
  extendByokTrialCheckout,
  hasBillingAccess,
  hasModelAccess,
  isLockTimeout,
  lockCheckoutLease,
  MICROS_PER_DOLLAR,
  needsBillingPortal,
  organizationForMember,
  organizationOwnerHadTrial,
  organizationSeatCount,
  ownedBillingAccounts,
  reconcileCreditPurchase,
  releaseByokTrialCheckout,
  releaseByokTrialCheckouts,
  releaseCheckoutLease,
  renewCheckoutLease,
  replaceBillingCustomer,
  reserveByokTrialCheckout,
  syncBillingSnapshot,
  unexpiredCreditAccount,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { applyAccessGrants } from "./access-grants.js";
import { createExperiments } from "./experiments.js";
import { createReferrals } from "./referrals.js";

export { TRIAL_DAYS };
/** An invited organization's first trial. */
export const INVITED_TRIAL_DAYS = INVITED_TRIAL_WEEKS * 7;
const PRICE_CACHE_MS = 60 * 60 * 1000;
const CHECKOUT_LEASE_MS = 120_000;
const CHECKOUT_LEASE_POLL_MS = 250;
/** Keeps a held lease valid through a provider operation longer than one lease period. */
const CHECKOUT_LEASE_RENEW_MS = CHECKOUT_LEASE_MS / 4;
/** Runs `write` in one transaction while this request still holds the checkout lease. */
type UnderLease = <R>(write: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;

/** Stripe returns here after checkout; served by the API through the web origin. */
export const BILLING_RETURN_PATH = "/api/v1/billing/return";

/** Where checkout was opened; the mobile app's in-app browser closes on the return. */
export type BillingClient = "mobile" | undefined;

/** Product-side billing: access rules, checkout, and pull-based sync from the provider. */
export interface BillingService {
  readonly modelCreditsEnabled: boolean;
  readonly referralsEnabled: boolean;
  status(actor: Actor): Promise<BillingStatus>;
  selectFunding(
    actor: Actor,
    funding: "byok" | "credits",
    client?: BillingClient,
    interval?: ByokInterval,
    tier?: ByokTier,
  ): Promise<{ ok: true; url?: string }>;
  purchaseCredits(
    actor: Actor,
    input: { amountCents: number; monthly: boolean; client?: BillingClient },
  ): Promise<{ url: string }>;
  setMonthlyCredits(actor: Actor, amountCents: number): Promise<{ ok: true }>;
  checkout(
    actor: Actor,
    client?: BillingClient,
    interval?: ByokInterval,
    tier?: ByokTier,
  ): Promise<{ url: string }>;
  portal(actor: Actor, client?: BillingClient): Promise<{ url: string }>;
  /** Ends the organization's trial and bills the first period now. */
  endTrial(actor: Actor): Promise<void>;
  switchToYearly(actor: Actor): Promise<void>;
  /** Moves the own-key plan to another tier at the same interval, billing the difference now. */
  changeTier(actor: Actor, tier: ByokTier): Promise<void>;
  /** Re-fetches the customer's subscription from the provider and overwrites the stored snapshot. */
  sync(customerId: string): Promise<void>;
  /** Syncs the actor's organization, e.g. on return from checkout before the webhook lands. */
  syncForActor(actor: Actor): Promise<void>;
  /** Pushes the organization's member count to the provider. Call when members change. */
  syncSeats(organizationId: string): Promise<void>;
  cancelForDeletedUser(userId: string): Promise<void>;
  cancelForDeletedOrganization(organizationId: string): Promise<void>;
  claimReferral(actor: Actor, code: string): Promise<void>;
}

/**
 * Only the own-key plan has a trial: credits are resold at cost. An organization that has
 * subscribed before, or was given a free own-key period, has had its trial, and so has its owner
 * when any organization of theirs has.
 */
function byokTrialAvailable(
  account: { subscribedAt: Date | null } | null,
  credits: { byokFreeUntil: Date | null },
  ownerHadOne: boolean,
) {
  return !ownerHadOne && !account?.subscribedAt && !credits.byokFreeUntil;
}

type PlanTerms = Omit<Extract<AnalyticsEvent, { name: "checkout_opened" }>, "name">;

/** The plan a subscription bills, as analytics reports it; monthly credits include own-key. */
function planTerms(live: BillingSubscriptionSnapshot): PlanTerms | null {
  if (live.creditAmountCents)
    return { plan: "credits", interval: "month", amountCents: live.creditAmountCents };
  if (live.byokPlan && live.byokPriceCents)
    return {
      plan: "own_key",
      tier: live.byokTier ?? "standard",
      interval: live.byokInterval ?? "month",
      amountCents: live.byokPriceCents,
    };
  return null;
}

/** A subscriber keeps the own-key price they signed up at until the subscription ends. */
function subscribedByokPrice(account: BillingAccount | null) {
  const status = account?.status ?? null;
  if (!account?.byokPriceCents || !(hasBillingAccess(status) || needsBillingPortal(status)))
    return null;
  const interval: ByokInterval = account.byokInterval === "year" ? "year" : "month";
  const tier = ByokTierSchema.catch("standard").parse(account.byokTier ?? "standard");
  return { cents: account.byokPriceCents, interval, tier };
}

/** The tiers on offer, in order; empty when the own-key plan is free. */
function byokTierOffers() {
  return ByokTierSchema.options.flatMap((tier) => {
    const monthlyPriceCents = byokTierPriceCents(tier, "month");
    if (monthlyPriceCents === null) return [];
    const terms = BYOK_TIERS[tier];
    return [
      {
        tier,
        name: terms.name,
        monthlyPriceCents,
        annualPriceCents: byokTierPriceCents(tier, "year"),
        computerSize: terms.computerSize,
        computerHours: sandboxAllowanceHours(terms.computerAllowanceCents),
      },
    ];
  });
}

export function createBillingService(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  /** Prices computer time for the monthly allowance; without it none is shown. */
  sandbox?: SandboxProvider;
  managedModelsAvailable?: boolean;
  /** The session cookie lives on the web origin, which also proxies /api to this server. */
  webOrigin: string;
  analytics?: ProductAnalytics;
  experiments?: ReturnType<typeof createExperiments>;
}): BillingService {
  const { prisma, provider } = deps;
  const experiments = deps.experiments ?? createExperiments(undefined);
  const appUrl = `${deps.webOrigin}/app`;
  const returnUrl = `${deps.webOrigin}${BILLING_RETURN_PATH}`;
  /** A mobile checkout returns through the API either way, which hands back to the app. */
  const mobileReturnUrl = `${returnUrl}?client=mobile`;
  const modelCredits = provider.describe().capabilities.modelCredits === true;
  const referrals = createReferrals(deps);
  let cachedPrice: { value: BillingPrice; expiresAt: number } | undefined;

  async function price(): Promise<BillingPrice | null> {
    if (cachedPrice && cachedPrice.expiresAt > Date.now()) return cachedPrice.value;
    try {
      const value = await provider.getPrice();
      cachedPrice = { value, expiresAt: Date.now() + PRICE_CACHE_MS };
      return value;
    } catch (error) {
      getLogger().error("billing price lookup failed", error);
      return null;
    }
  }

  async function organization(actor: Actor) {
    const found = await organizationForMember(prisma, {
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    if (!found) throw new ORPCError("FORBIDDEN");
    return found;
  }

  async function managedOrganization(actor: Actor) {
    const found = await organization(actor);
    if (!found.isOwner) throw new ORPCError("FORBIDDEN");
    // Deletion cancels billing once, so nothing may start a charge after it claims the org.
    if (await organizationBeingDeleted(found.organizationId))
      throw new ORPCError("CONFLICT", { message: "Organization is being deleted" });
    return found;
  }

  async function organizationBeingDeleted(organizationId: string) {
    const deleting = await prisma.space.findFirst({
      where: { organizationId, isDefault: true, deletingAt: { not: null } },
      select: { id: true },
    });
    return deleting !== null;
  }

  async function sync(customerId: string): Promise<void> {
    if (modelCredits && provider.listCreditPurchases) {
      const account = await prisma.billingAccount.findUnique({ where: { customerId } });
      if (account) {
        let added = false;
        for (const purchase of await provider.listCreditPurchases(customerId)) {
          if ((await reconcileCreditPurchase(prisma, account.organizationId, purchase)) > 0)
            added = true;
        }
        await prisma.modelCreditAccount.updateMany({
          where: {
            organizationId: account.organizationId,
            balanceMicros: { gt: 0n },
            OR: [{ mode: null }, ...(added ? [{ pendingCreditCheckout: true }] : [])],
          },
          data: { mode: "credits", pendingCreditCheckout: false },
        });
      }
    }
    const previous = await prisma.billingAccount.findUnique({ where: { customerId } });
    // Assigned in the callback, which control-flow narrowing does not follow.
    let snapshot = null as BillingSubscriptionSnapshot | null;
    const written = await syncBillingSnapshot(prisma, customerId, async () => {
      snapshot = await provider.getCustomerSubscription(customerId);
      return snapshot;
    });
    if (!written || !previous) {
      getLogger().warn("billing sync for unknown customer", { "billing.customer_id": customerId });
      return;
    }
    const live = snapshot;
    // Measurement never decides whether a paid plan activates.
    if (live)
      try {
        await reportCancellation(previous, live);
        await reportPlanChange(previous, live);
      } catch (error) {
        getLogger().warn("billing analytics failed", {
          "error.message": error instanceof Error ? error.message : String(error),
        });
      }
    if (live && hasBillingAccess(live.status))
      await referrals.settle(previous.organizationId, live.cardFingerprint);
    if (!modelCredits || !live) return;
    // A newly paid own-key plan becomes the funding, wherever its checkout returned.
    if (
      live.byokPlan &&
      hasBillingAccess(live.status) &&
      live.subscriptionId !== previous.subscriptionId
    )
      // Only while this snapshot is still the stored one: a newer sync's write wins.
      await prisma.modelCreditAccount.updateMany({
        where: {
          organizationId: previous.organizationId,
          organization: { billing: { subscriptionId: live.subscriptionId } },
        },
        data: { mode: "byok", pendingCreditCheckout: false },
      });
    // Monthly credits include the own-key plan, even when they will not renew, and a free plan
    // bills nothing.
    if (
      provider.endByokPlans &&
      hasBillingAccess(live.status) &&
      (live.creditAmountCents ||
        (BYOK_TIERS.standard.monthlyPriceCents === null &&
          live.byokPlan &&
          !live.cancelAtPeriodEnd))
    )
      await provider.endByokPlans(customerId);
  }

  async function reportCancellation(previous: BillingAccount, live: BillingSubscriptionSnapshot) {
    const { analytics } = deps;
    if (
      !analytics ||
      !(live.cancellationReason || live.cancellationComment) ||
      (live.cancellationReason === (previous.cancellationReason ?? undefined) &&
        live.cancellationComment === (previous.cancellationComment ?? undefined))
    )
      return;
    const owner = await ownerUserId(previous.organizationId);
    if (!owner) return;
    analytics.capture(owner, {
      name: "subscription_cancel_feedback",
      ...(live.cancellationReason ? { reason: live.cancellationReason } : {}),
      commented: Boolean(live.cancellationComment),
    });
  }

  /**
   * Reports a new subscription, or the end of its trial, when a sync records it. Concurrent syncs
   * can both see the change, so each event carries the subscription and a time from its snapshot,
   * which the analytics provider deduplicates on.
   */
  async function reportPlanChange(previous: BillingAccount, live: BillingSubscriptionSnapshot) {
    const { analytics } = deps;
    const same = live.subscriptionId === previous.subscriptionId;
    // A checkout whose first payment was still pending syncs as incomplete before it starts.
    const started = hasBillingAccess(live.status) && (!same || previous.status === "incomplete");
    const trialEnded = same && previous.status === "trialing" && live.status !== "trialing";
    const terms = planTerms(live);
    if (!analytics || !terms || !(started || trialEnded)) return;
    const owner = await ownerUserId(previous.organizationId);
    if (!owner) return;
    const at = (started ? live.currentPeriodStartsAt : live.trialEndsAt) ?? new Date();
    analytics.capture(
      owner,
      started
        ? { name: "subscription_started", ...terms, trial: live.status === "trialing" }
        : { name: "trial_ended", ...terms, converted: live.status === "active" },
      { id: live.subscriptionId, at },
      experiments.tags("plan-layout", previous.organizationId),
    );
  }

  async function ownerUserId(organizationId: string) {
    const owner = await prisma.member.findFirst({
      where: { organizationId, role: { contains: "owner" } },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    return owner?.userId;
  }

  async function cancel(account: BillingAccount) {
    // Holds the organization's checkout lease, so a checkout still opening finishes first and
    // the session it leaves is expired here instead of outliving the cancellation.
    await withCheckoutLease(account.organizationId, async () => {
      await provider.cancelCustomerSubscriptions(account.customerId);
      await sync(account.customerId);
    });
  }

  async function newCustomer(actor: Actor, organizationId: string) {
    return (await provider.createCustomer({ email: actor.email, organizationId })).customerId;
  }

  /** Runs `call`; if the provider deleted the customer, swaps in a new one and runs it again. */
  async function withLiveCustomer<T>(
    actor: Actor,
    account: BillingAccount,
    call: (customerId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(account.customerId);
    } catch (error) {
      if (!(error instanceof BillingCustomerNotFoundError)) throw error;
      const replaced = await replaceBillingCustomer(prisma, {
        organizationId: account.organizationId,
        previousCustomerId: account.customerId,
        customerId: await newCustomer(actor, account.organizationId),
      });
      return call(replaced.customerId);
    }
  }

  /** Opens a checkout, one per organization at a time across API instances. */
  async function openCheckout(
    actor: Actor,
    account: BillingAccount,
    call: (customerId: string, underLease: UnderLease) => Promise<{ url: string }>,
  ) {
    // Opening another recurring checkout expires the old one.
    return withCheckoutLease(account.organizationId, async (underLease) => {
      // The entry check ran before this request waited for the lease, and a deletion's
      // cancellation holds the same lease: re-check, so no session opens that the
      // cancellation cannot see and the organization cannot outlive.
      if (await organizationBeingDeleted(account.organizationId))
        throw new ORPCError("CONFLICT", { message: "Organization is being deleted" });
      return withLiveCustomer(actor, account, (customerId) => call(customerId, underLease));
    });
  }

  /**
   * Runs `work` holding the organization's checkout lease, one at a time across API instances.
   * `underLease` runs writes that must not outlive the lease.
   */
  async function withCheckoutLease<T>(
    organizationId: string,
    work: (underLease: UnderLease) => Promise<T>,
  ) {
    const deadline = Date.now() + CHECKOUT_LEASE_MS;
    let leaseId = await claimCheckoutLease(prisma, organizationId, CHECKOUT_LEASE_MS);
    while (!leaseId) {
      if (Date.now() > deadline) throw new ORPCError("CONFLICT");
      await sleep(CHECKOUT_LEASE_POLL_MS);
      leaseId = await claimCheckoutLease(prisma, organizationId, CHECKOUT_LEASE_MS);
    }
    // A provider operation can outlast the lease's validity, so renew it while work runs; a
    // deletion's cancellation then waits for the operation instead of taking the lease over
    // mid-flight. A renewal that finds the lease lapsed leaves it to the next claimant.
    const renew = setInterval(
      () =>
        void renewCheckoutLease(prisma, organizationId, leaseId, CHECKOUT_LEASE_MS).catch(() => {}),
      CHECKOUT_LEASE_RENEW_MS,
    );
    renew.unref();
    // The lease row stays locked until the writes commit, so no claimant takes it meanwhile.
    const busy = () => new ORPCError("CONFLICT", { message: "Billing is busy; try again shortly" });
    const underLease: UnderLease = (write) =>
      prisma
        .$transaction(async (tx) => {
          if (!(await lockCheckoutLease(tx, organizationId, leaseId))) throw busy();
          return write(tx);
        })
        .catch((error: unknown) => {
          // A write that waited too long on another lock rolled back: busy, like a lost lease.
          if (isLockTimeout(error)) throw busy();
          throw error;
        });
    try {
      const result = await work(underLease);
      // Renewal keeps the lease unless the database refused every attempt for a whole lease
      // period. A cancellation that still took the lease over expired the sessions open at
      // that moment, so a session created after it must not be handed back.
      if (!(await checkoutLeaseHeld(prisma, organizationId, leaseId)))
        throw new ORPCError("CONFLICT", { message: "Billing is busy; try again shortly" });
      return result;
    } finally {
      clearInterval(renew);
      await releaseCheckoutLease(prisma, organizationId, leaseId);
    }
  }

  async function trialDays(organizationId: string) {
    return (await referrals.invited(organizationId)) ? INVITED_TRIAL_DAYS : TRIAL_DAYS;
  }

  async function billingAccountFor(actor: Actor, organizationId: string) {
    return (
      (await billingAccountForOrganization(prisma, organizationId)) ??
      createBillingAccount(prisma, {
        organizationId,
        customerId: await newCustomer(actor, organizationId),
      })
    );
  }

  async function byokCheckout(
    actor: Actor,
    organizationId: string,
    client: BillingClient,
    interval: ByokInterval = "month",
    tier: ByokTier = "standard",
  ) {
    const amountCents = byokTierPriceCents(tier, interval);
    if (amountCents === null || !provider.createByokCheckout) throw new ORPCError("NOT_FOUND");
    const [account, credits, days, hadTrial] = await Promise.all([
      billingAccountFor(actor, organizationId),
      creditAccount(prisma, organizationId),
      trialDays(organizationId),
      organizationOwnerHadTrial(prisma, organizationId, "byok"),
    ]);
    try {
      const session = await openCheckout(actor, account, async (customerId, underLease) => {
        // Expire the open sessions first: once none is payable none holds the trial, so a
        // failure after this step gives this attempt's hold back in full. A failure while
        // expiring keeps the earlier hold, since its session may still be payable.
        await provider.expireOpenCheckouts(customerId);
        // A session paid before it could be expired leaves a subscription whose webhook may
        // not have arrived: record it, using up the owners' trial, while the earlier hold
        // still protects it. A failed sync keeps that hold.
        await sync(customerId);
        // One trial per owner: the sync can outlast the lease, after which a newer request
        // may hold a newer session's hold, so release and reserve only while the lease is
        // still this request's and its row stays locked.
        const hold = await underLease(async (tx) => {
          await releaseByokTrialCheckouts(tx, organizationId);
          return byokTrialAvailable(account, credits, hadTrial)
            ? reserveByokTrialCheckout(tx, organizationId)
            : null;
        });
        let session: { url: string };
        try {
          session = await provider.createByokCheckout!({
            customerId,
            amountCents,
            interval,
            tier,
            ...(hold ? { trialDays: days } : {}),
            successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
            cancelUrl: client === "mobile" ? mobileReturnUrl : appUrl,
          });
        } catch (error) {
          // No session came out of this attempt, so its hold goes back; a newer payable
          // session's hold keeps its own expiry and survives.
          if (hold && !(error instanceof BillingCheckoutCompletedError))
            await releaseByokTrialCheckout(prisma, organizationId, hold);
          throw error;
        }
        // The session starts expiring at its creation, so the hold lasts from there too. A
        // failure here must not give the hold back: the session exists and stays payable.
        if (hold) await extendByokTrialCheckout(prisma, organizationId, hold);
        return session;
      });
      deps.analytics?.capture(
        actor.userId,
        { name: "checkout_opened", plan: "own_key", tier, interval, amountCents },
        undefined,
        experiments.tags("plan-layout", organizationId),
      );
      return session;
    } catch (error) {
      if (!(error instanceof BillingCheckoutCompletedError)) throw error;
      await sync(account.customerId);
      throw new ORPCError("CONFLICT", { message: "Manage your existing subscription in Billing" });
    }
  }

  /**
   * Moves the organization's live own-key plan to the plan `target` picks for it, charging the
   * difference now. Conflicts when there is no such plan or `target` offers no change.
   */
  async function changeByokPlan(
    actor: Actor,
    target: (from: BillingByokPlan) => BillingByokPlan | null,
  ) {
    if (!provider.changeByokPlan) throw new ORPCError("NOT_FOUND");
    const { organizationId } = await managedOrganization(actor);
    const stored = await billingAccountForOrganization(prisma, organizationId);
    if (!stored) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
    // One change at a time, so a second owner's change is decided from the first one's result.
    await withCheckoutLease(organizationId, async () => {
      // Decide from the provider, not a snapshot a missed webhook may have left stale.
      await sync(stored.customerId);
      const account = await billingAccountForOrganization(prisma, organizationId);
      const conflict = () => new ORPCError("CONFLICT", { message: "No own-key plan to change" });
      const subscribed = subscribedByokPrice(account);
      if (
        !account?.subscriptionId ||
        !subscribed ||
        account.creditAmountCents ||
        account.cancelAtPeriodEnd ||
        // Paid up: an overdue period must not be credited against the new plan.
        (account.status !== "active" && account.status !== "trialing")
      )
        throw conflict();
      const from = {
        tier: subscribed.tier,
        interval: subscribed.interval,
        amountCents: subscribed.cents,
      };
      const to = target(from);
      if (!to) throw conflict();
      // A smaller allowance takes effect at once, so this period's computer use must already fit it;
      // otherwise an upgrade could buy a period's hours and a downgrade refund almost all of it.
      const allowanceCents = BYOK_TIERS[to.tier].computerAllowanceCents;
      if (allowanceCents < BYOK_TIERS[from.tier].computerAllowanceCents && deps.sandbox) {
        const allowance = await sandboxAllowance({ prisma, sandbox: deps.sandbox }, organizationId);
        if (allowance && allowance.usedMicros > (allowanceCents * MICROS_PER_DOLLAR) / 100)
          throw new ORPCError("CONFLICT", {
            message: "This month's computer use is more than the smaller plan includes",
          });
      }
      const changed = await provider.changeByokPlan!(account.customerId, account.subscriptionId, {
        from,
        to,
      });
      await sync(account.customerId);
      if (!changed) throw conflict();
    });
  }

  return {
    modelCreditsEnabled: modelCredits,
    referralsEnabled: referrals.enabled,
    async selectFunding(actor, funding, client, interval, tier) {
      const { organizationId } = await managedOrganization(actor);
      // Choosing credits must see the balance left after any lapsed monthly credits expire.
      if (funding === "credits") await expireModelCredits(prisma, organizationId);
      const account = await creditAccount(prisma, organizationId);
      const subscription = await billingAccountForOrganization(prisma, organizationId);
      if (
        funding === "byok" &&
        subscription?.creditAmountCents &&
        !subscription.cancelAtPeriodEnd &&
        !["canceled", "incomplete_expired"].includes(subscription.status ?? "")
      )
        throw new ORPCError("CONFLICT", {
          message: "Cancel monthly credits in Billing before switching to your API key.",
        });
      // An unpaid own-key choice keeps the current funding until checkout completes.
      if (
        funding === "byok" &&
        !hasModelAccess({ ...account, mode: "byok" }, subscription?.status ?? null)
      )
        return { ok: true, ...(await byokCheckout(actor, organizationId, client, interval, tier)) };
      await prisma.modelCreditAccount.update({
        where: { organizationId },
        data: {
          mode: funding === "byok" ? "byok" : account.balanceMicros > 0n ? "credits" : null,
          pendingCreditCheckout: false,
        },
      });
      return { ok: true };
    },

    async purchaseCredits(actor, { client, ...input }) {
      if (!modelCredits || !provider.createCreditCheckout) throw new ORPCError("NOT_FOUND");
      if (deps.managedModelsAvailable === false) throw new ORPCError("PRECONDITION_FAILED");
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountFor(actor, organizationId);
      await creditAccount(prisma, organizationId);
      try {
        const checkout = await openCheckout(actor, account, (customerId) =>
          provider.createCreditCheckout!({
            customerId,
            ...input,
            successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
            cancelUrl: client === "mobile" ? mobileReturnUrl : `${appUrl}?billing=canceled`,
          }),
        );
        await prisma.modelCreditAccount.update({
          where: { organizationId },
          data: { pendingCreditCheckout: true },
        });
        if (input.monthly)
          deps.analytics?.capture(
            actor.userId,
            {
              name: "checkout_opened",
              plan: "credits",
              interval: "month",
              amountCents: input.amountCents,
            },
            undefined,
            experiments.tags("plan-layout", organizationId),
          );
        return checkout;
      } catch (error) {
        if (error instanceof BillingCheckoutCompletedError)
          throw new ORPCError("CONFLICT", {
            message: "Manage your existing subscription in Billing",
          });
        throw error;
      }
    },

    async setMonthlyCredits(actor, amountCents) {
      if (!modelCredits || !provider.setMonthlyCredits) throw new ORPCError("NOT_FOUND");
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND");
      try {
        await provider.setMonthlyCredits(account.customerId, amountCents);
      } catch (error) {
        if (error instanceof BillingPaymentNotCompletedError)
          throw new ORPCError("PAYMENT_REQUIRED", { status: 402, message: error.message });
        if (!(error instanceof BillingNoMonthlyCreditsError)) throw error;
        // The plan ended after the page loaded; syncing lets the next status offer Subscribe.
        await sync(account.customerId);
        throw new ORPCError("CONFLICT", { message: error.message, cause: error });
      }
      await sync(account.customerId);
      return { ok: true };
    },

    async status(actor) {
      if (modelCredits) {
        const { organizationId, isOwner } = await organization(actor);
        if (isOwner)
          await applyAccessGrants(prisma, { ...actor, organizationId }).catch((error) =>
            getLogger().error("access grant failed", error),
          );
        const [credits, account, computerAllowance, days, hadTrial] = await Promise.all([
          unexpiredCreditAccount(prisma, organizationId),
          billingAccountForOrganization(prisma, organizationId),
          deps.sandbox ? sandboxAllowance({ prisma, sandbox: deps.sandbox }, organizationId) : null,
          trialDays(organizationId),
          organizationOwnerHadTrial(prisma, organizationId, "byok"),
        ]);
        const freeUntil =
          credits.mode === "byok" &&
          BYOK_TIERS.standard.monthlyPriceCents !== null &&
          !hasBillingAccess(account?.status ?? null)
            ? byokFreeUntil(credits)
            : null;
        const subscribed = subscribedByokPrice(account);
        const tier = subscribed?.tier ?? "standard";
        const offers = byokTierOffers();
        return {
          access: hasModelAccess(credits, account?.status ?? null),
          funding:
            credits.mode === "byok"
              ? "byok"
              : credits.balanceMicros > 0n || credits.mode === "credits"
                ? "credits"
                : null,
          balanceUsd: Number(credits.balanceMicros) / MICROS_PER_DOLLAR,
          monthlyAmountCents: account?.creditAmountCents ?? null,
          creditPurchasesEnabled: deps.managedModelsAvailable ?? true,
          byokPriceCents:
            BYOK_TIERS.standard.monthlyPriceCents &&
            (subscribed?.cents ?? BYOK_TIERS.standard.monthlyPriceCents),
          byokInterval: subscribed?.interval ?? "month",
          byokAnnualPriceCents: byokTierPriceCents(tier, "year"),
          byokTier: tier,
          ...(offers.length ? { byokTiers: offers } : {}),
          // New organizations only, so a returning subscriber's choice stays out of the comparison.
          ...(offers.length > 1 && !account?.subscribedAt && experiments.running("plan-layout")
            ? { planLayout: experiments.variant("plan-layout", organizationId) }
            : {}),
          byokFreeUntil: freeUntil?.toISOString() ?? null,
          canManage: isOwner,
          trialAvailable:
            BYOK_TIERS.standard.monthlyPriceCents !== null &&
            byokTrialAvailable(account, credits, hadTrial),
          trialDays: days,
          state: (account?.status ?? "none") as BillingStatus["state"],
          price: account?.creditAmountCents
            ? {
                amount: account.creditAmountCents,
                currency: "usd",
                interval: "month" as const,
                intervalCount: 1,
              }
            : null,
          seats: 1,
          trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
          currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
          hasCustomer: Boolean(account),
          computerHoursLeft: computerAllowance && sandboxHoursLeft(computerAllowance),
          computerHoursResetAt: computerAllowance?.resetsAt?.toISOString() ?? null,
          referral: await referrals.status(organizationId, isOwner),
        };
      }
      const { organizationId, isOwner } = await organization(actor);
      const [account, currentPrice, days, hadTrial] = await Promise.all([
        billingAccountForOrganization(prisma, organizationId),
        price(),
        trialDays(organizationId),
        organizationOwnerHadTrial(prisma, organizationId, "managed"),
      ]);
      const status = account?.status ?? null;
      return {
        access: hasBillingAccess(status),
        canManage: isOwner,
        trialAvailable: !account?.subscribedAt && !hadTrial,
        trialDays: days,
        state: (status ?? "none") as BillingStatus["state"],
        price: currentPrice,
        seats: account?.seats ?? (await organizationSeatCount(prisma, organizationId)),
        trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
        hasCustomer: Boolean(account),
      };
    },

    async checkout(actor, client, interval, tier) {
      const { organizationId } = await managedOrganization(actor);
      if (modelCredits) return byokCheckout(actor, organizationId, client, interval, tier);
      let account = await billingAccountForOrganization(prisma, organizationId);
      if (account) {
        // Decide from the provider, not a snapshot a missed webhook may have left stale.
        await sync(account.customerId);
        account = await billingAccountForOrganization(prisma, organizationId);
      }
      if (hasBillingAccess(account?.status ?? null)) {
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
      // The existing subscription resumes once paid; a new checkout would bill twice.
      if (needsBillingPortal(account?.status ?? null)) {
        throw new ORPCError("CONFLICT", { message: "Resume the subscription in billing" });
      }
      account ??= await createBillingAccount(prisma, {
        organizationId,
        customerId: await newCustomer(actor, organizationId),
      });
      const seats = await organizationSeatCount(prisma, organizationId);
      const trial =
        account.subscribedAt || (await organizationOwnerHadTrial(prisma, organizationId, "managed"))
          ? {}
          : { trialDays: await trialDays(organizationId) };
      try {
        return await openCheckout(actor, account, (customerId) =>
          provider.createCheckout({
            customerId,
            seats,
            ...trial,
            successUrl: client === "mobile" ? mobileReturnUrl : returnUrl,
            cancelUrl: client === "mobile" ? mobileReturnUrl : appUrl,
          }),
        );
      } catch (error) {
        if (!(error instanceof BillingCheckoutCompletedError)) throw error;
        await sync(account.customerId);
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
    },

    async portal(actor, client) {
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      return withLiveCustomer(actor, account, (customerId) =>
        provider.createPortal({
          customerId,
          returnUrl: client === "mobile" ? mobileReturnUrl : appUrl,
        }),
      );
    },

    async endTrial(actor) {
      if (!provider.endTrial) throw new ORPCError("NOT_FOUND");
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      try {
        await provider.endTrial(account.customerId);
      } catch (error) {
        if (!(error instanceof BillingPaymentNotCompletedError)) throw error;
        throw new ORPCError("PAYMENT_REQUIRED", { status: 402, message: error.message });
      }
      await sync(account.customerId);
    },

    async switchToYearly(actor) {
      await changeByokPlan(actor, (from) => {
        const amountCents = byokTierPriceCents(from.tier, "year");
        // A subscriber on an older, cheaper price would pay more.
        return from.interval === "month" &&
          amountCents !== null &&
          from.amountCents * 12 > amountCents
          ? { tier: from.tier, interval: "year", amountCents }
          : null;
      });
    },

    async changeTier(actor, tier) {
      await changeByokPlan(actor, (from) => {
        const amountCents = byokTierPriceCents(tier, from.interval);
        return tier !== from.tier && amountCents !== null
          ? { tier, interval: from.interval, amountCents }
          : null;
      });
    },

    sync,

    async syncForActor(actor) {
      const { organizationId } = await organization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (account) await sync(account.customerId);
    },

    async syncSeats(organizationId) {
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account || account.creditAmountCents) return;
      const seats = await organizationSeatCount(prisma, organizationId);
      if (account.seats === seats) return;
      await provider.updateSeats(account.customerId, seats);
      await sync(account.customerId);
    },

    async claimReferral(actor, code) {
      const { organizationId, isOwner } = await organization(actor);
      if (isOwner) await referrals.claim(organizationId, code, actor.userId);
    },

    async cancelForDeletedUser(userId) {
      for (const account of await ownedBillingAccounts(prisma, userId)) await cancel(account);
    },

    async cancelForDeletedOrganization(organizationId) {
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) return;
      await cancel(account);
      // The cancellation expired the organization's open checkout sessions, so their hold on
      // the owners' trial goes; a failed cancellation keeps it until a retry succeeds.
      await releaseByokTrialCheckouts(prisma, organizationId);
    },
  };
}

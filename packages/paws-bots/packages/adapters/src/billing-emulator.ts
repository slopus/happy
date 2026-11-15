import type {
  BillingByokCheckoutRequest,
  BillingByokPlan,
  BillingCheckoutRequest,
  BillingCreditCheckoutRequest,
  BillingCreditPurchase,
  BillingPrice,
  BillingProvider,
  BillingSubscriptionSnapshot,
  BillingSubscriptionStatus,
} from "@rakazo/adapter-kit";
import {
  BillingCheckoutCompletedError,
  BillingCustomerNotFoundError,
  BillingNoMonthlyCreditsError,
} from "@rakazo/adapter-kit";
import {
  holdsBillingSubscription,
  parseStripeWebhook,
  pickBillingSubscription,
  signStripeWebhook,
} from "./stripe-billing.js";

const WEBHOOK_SECRET = "billing-emulator-webhook-secret";
const BYOK_PRICE_ID = "price_byok_emulated";

export interface BillingEmulatorOptions {
  namespace?: string;
  modelCredits?: boolean;
  price?: BillingPrice;
  now?: () => number;
}

type EmulatedSubscription = BillingSubscriptionSnapshot & { customerId: string; created: number };

/** Offline, deterministic billing provider for development and tests. */
export class BillingEmulator implements BillingProvider {
  readonly price: BillingPrice;
  readonly modelCredits: boolean;
  readonly creditCheckouts = new Map<string, BillingCreditCheckoutRequest>();
  readonly byokCheckouts = new Map<string, BillingByokCheckoutRequest>();
  readonly creditPurchases = new Map<string, BillingCreditPurchase[]>();
  readonly customers = new Map<string, { email: string; organizationId: string }>();
  readonly checkouts = new Map<string, BillingCheckoutRequest>();
  readonly subscriptions: EmulatedSubscription[] = [];
  /** Account credit granted per customer, in cents. */
  readonly balanceCredits = new Map<string, number>();
  private readonly now: () => number;
  private sequence = 0;
  private customerSequence = 0;
  private readonly namespace: string;

  constructor(options: BillingEmulatorOptions = {}) {
    this.modelCredits = options.modelCredits === true;
    this.namespace = options.namespace ?? "emulated";
    this.price = options.price ?? {
      amount: 1000,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
    };
    this.now = options.now ?? Date.now;
  }

  describe() {
    return {
      id: "billing-emulator",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { trials: true, portal: true, modelCredits: this.modelCredits },
    };
  }

  async getPrice() {
    return { ...this.price };
  }

  async createCustomer(input: { email: string; organizationId: string }) {
    const customerId = `cus_${this.namespace}_${++this.customerSequence}`;
    this.customers.set(customerId, { ...input });
    return { customerId };
  }

  async createCheckout(input: BillingCheckoutRequest) {
    this.requireCustomer(input.customerId);
    if (this.forCustomer(input.customerId).some((s) => holdsBillingSubscription(s.status)))
      throw new BillingCheckoutCompletedError();
    this.checkouts.set(input.customerId, { ...input });
    return { url: `https://billing.emulator.invalid/checkout/${input.customerId}` };
  }

  async createCreditCheckout(input: BillingCreditCheckoutRequest) {
    this.requireCustomer(input.customerId);
    if (
      input.monthly &&
      this.forCustomer(input.customerId).some(
        (s) => s.priceId !== BYOK_PRICE_ID && holdsBillingSubscription(s.status),
      )
    )
      throw new BillingCheckoutCompletedError();
    this.creditCheckouts.set(input.customerId, input);
    return { url: `https://billing.emulator.invalid/credits/${input.customerId}` };
  }

  async createByokCheckout(input: BillingByokCheckoutRequest) {
    this.requireCustomer(input.customerId);
    if (this.forCustomer(input.customerId).some((s) => holdsBillingSubscription(s.status)))
      throw new BillingCheckoutCompletedError();
    this.byokCheckouts.set(input.customerId, input);
    return { url: `https://billing.emulator.invalid/byok/${input.customerId}` };
  }

  async endTrial(customerId: string) {
    const chosen = pickBillingSubscription(this.forCustomer(customerId));
    if (chosen?.status !== "trialing" || chosen.cancelAtPeriodEnd) return;
    chosen.status = "active";
    chosen.trialEndsAt = new Date(this.now());
    chosen.currentPeriodStartsAt = new Date(this.now());
    chosen.currentPeriodEndsAt = new Date(
      this.now() + (chosen.byokInterval === "year" ? 365 : 30) * 86400000,
    );
  }

  async changeByokPlan(
    customerId: string,
    subscriptionId: string,
    { from, to }: { from: BillingByokPlan; to: BillingByokPlan },
  ) {
    const subscriptions = this.forCustomer(customerId);
    const plan = subscriptions.find((s) => s.subscriptionId === subscriptionId);
    if (
      !plan ||
      plan.priceId !== BYOK_PRICE_ID ||
      (plan.status !== "active" && plan.status !== "trialing") ||
      plan.cancelAtPeriodEnd ||
      plan.byokTier !== from.tier ||
      plan.byokInterval !== from.interval ||
      plan.byokPriceCents !== from.amountCents ||
      subscriptions.some((s) => s.creditAmountCents && holdsBillingSubscription(s.status))
    )
      return false;
    plan.byokTier = to.tier;
    plan.byokPriceCents = to.amountCents;
    plan.byokInterval = to.interval;
    if (plan.status === "trialing" || to.interval === from.interval) return true;
    plan.currentPeriodStartsAt = new Date(this.now());
    plan.currentPeriodEndsAt = new Date(
      this.now() + (to.interval === "year" ? 365 : 30) * 86400000,
    );
    return true;
  }

  async endByokPlans(customerId: string) {
    for (const subscription of this.forCustomer(customerId))
      if (subscription.priceId === BYOK_PRICE_ID) subscription.cancelAtPeriodEnd = true;
  }

  private readonly balanceReferences = new Set<string>();

  async grantBalanceCredit(customerId: string, amountCents: number, referenceId: string) {
    this.requireCustomer(customerId);
    if (this.balanceReferences.has(referenceId)) return;
    this.balanceReferences.add(referenceId);
    this.balanceCredits.set(customerId, (this.balanceCredits.get(customerId) ?? 0) + amountCents);
  }

  /** Test helper: the customer pays for the own-key plan checkout they started. */
  completeByokCheckout(customerId: string, cardFingerprint = `card_${customerId}`) {
    const checkout = this.byokCheckouts.get(customerId);
    if (!checkout) throw new Error("No own-key checkout");
    this.byokCheckouts.delete(customerId);
    const n = ++this.sequence;
    const trialEndsAt = checkout.trialDays
      ? new Date(this.now() + checkout.trialDays * 86400000)
      : null;
    this.subscriptions.push({
      customerId,
      created: Math.floor(this.now() / 1000) + n,
      subscriptionId: `sub_byok_${n}`,
      subscriptionItemId: `si_byok_${n}`,
      priceId: BYOK_PRICE_ID,
      byokPlan: true,
      byokPriceCents: checkout.amountCents,
      byokInterval: checkout.interval ?? "month",
      byokTier: checkout.tier ?? "standard",
      cardFingerprint,
      status: trialEndsAt ? "trialing" : "active",
      seats: 1,
      trialEndsAt,
      currentPeriodStartsAt: new Date(this.now()),
      currentPeriodEndsAt:
        trialEndsAt ?? new Date(this.now() + (checkout.interval === "year" ? 365 : 30) * 86400000),
      cancelAtPeriodEnd: false,
      endedAt: null,
    });
    return `sub_byok_${n}`;
  }

  async listCreditPurchases(customerId: string) {
    this.requireCustomer(customerId);
    this.renewCredits(customerId);
    return [...(this.creditPurchases.get(customerId) ?? [])];
  }

  async setMonthlyCredits(customerId: string, amountCents: number) {
    this.renewCredits(customerId);
    const chosen = pickBillingSubscription(this.forCustomer(customerId));
    if (!chosen?.creditAmountCents || !holdsBillingSubscription(chosen.status))
      throw new BillingNoMonthlyCreditsError();
    if (amountCents > chosen.creditAmountCents) {
      this.creditPurchases.set(customerId, [
        ...(this.creditPurchases.get(customerId) ?? []),
        {
          id: `upgrade_${this.namespace}_${++this.sequence}`,
          amountCents: amountCents - chosen.creditAmountCents,
          expiresAt: chosen.currentPeriodEndsAt?.toISOString(),
        },
      ]);
    }
    chosen.creditAmountCents = amountCents;
  }

  completeCreditCheckout(customerId: string, cardFingerprint = `card_${customerId}`) {
    const checkout = this.creditCheckouts.get(customerId);
    if (!checkout) throw new Error("No credit checkout");
    this.creditCheckouts.delete(customerId);
    const purchase = {
      id: `credit_${this.namespace}_${++this.sequence}`,
      amountCents: checkout.amountCents,
      ...(checkout.monthly
        ? { expiresAt: new Date(this.now() + 30 * 86400000).toISOString() }
        : {}),
    };
    this.creditPurchases.set(customerId, [
      ...(this.creditPurchases.get(customerId) ?? []),
      purchase,
    ]);
    if (checkout.monthly) {
      this.subscriptions.push({
        customerId,
        created: Math.floor(this.now() / 1000) + this.sequence,
        subscriptionId: `sub_credit_${this.sequence}`,
        subscriptionItemId: `si_credit_${this.sequence}`,
        priceId: "price_credit_emulated",
        cardFingerprint,
        status: "active",
        seats: 1,
        creditAmountCents: checkout.amountCents,
        trialEndsAt: null,
        currentPeriodStartsAt: new Date(this.now()),
        currentPeriodEndsAt: new Date(this.now() + 30 * 86400000),
        cancelAtPeriodEnd: false,
        endedAt: null,
      });
    }
    return purchase;
  }

  async createPortal(input: { customerId: string; returnUrl: string }) {
    this.requireCustomer(input.customerId);
    return { url: `https://billing.emulator.invalid/portal/${input.customerId}` };
  }

  async getCustomerSubscription(customerId: string) {
    this.renewCredits(customerId);
    const chosen = pickBillingSubscription(this.forCustomer(customerId));
    if (!chosen) return null;
    const { customerId: _customer, created: _created, ...snapshot } = chosen;
    return { ...snapshot };
  }

  async updateSeats(customerId: string, seats: number) {
    const chosen = pickBillingSubscription(this.forCustomer(customerId));
    if (chosen && chosen.priceId !== BYOK_PRICE_ID && holdsBillingSubscription(chosen.status))
      chosen.seats = seats;
  }

  async cancelCustomerSubscriptions(customerId: string) {
    this.cancelAll(customerId);
  }

  async expireOpenCheckouts(customerId: string) {
    this.checkouts.delete(customerId);
    this.byokCheckouts.delete(customerId);
    this.creditCheckouts.delete(customerId);
  }

  parseWebhook(rawBody: string, headers: Headers) {
    return parseStripeWebhook(WEBHOOK_SECRET, rawBody, headers, this.now());
  }

  /** Test helper: the customer finishes the last checkout they started. */
  completeCheckout(
    customerId: string,
    status?: BillingSubscriptionStatus,
    cardFingerprint = `card_${customerId}`,
  ) {
    const checkout = this.checkouts.get(customerId);
    if (!checkout) throw new Error(`No checkout for ${customerId}`);
    const n = ++this.sequence;
    const nowSeconds = Math.floor(this.now() / 1000);
    const trialEnd = checkout.trialDays ? nowSeconds + checkout.trialDays * 86_400 : null;
    this.subscriptions.push({
      customerId,
      created: nowSeconds + n,
      subscriptionId: `sub_emulated_${n}`,
      subscriptionItemId: `si_emulated_${n}`,
      priceId: "price_emulated",
      cardFingerprint,
      status: status ?? (trialEnd ? "trialing" : "active"),
      seats: checkout.seats,
      trialEndsAt: trialEnd === null ? null : new Date(trialEnd * 1000),
      currentPeriodStartsAt: new Date(nowSeconds * 1000),
      currentPeriodEndsAt: new Date((trialEnd ?? nowSeconds + 30 * 86_400) * 1000),
      cancelAtPeriodEnd: false,
      endedAt: null,
    });
    return `sub_emulated_${n}`;
  }

  /** Test helper: moves the customer's newest subscription to `status`. */
  setStatus(customerId: string, status: BillingSubscriptionStatus) {
    const newest = this.forCustomer(customerId).sort((a, b) => b.created - a.created)[0];
    if (!newest) throw new Error(`No subscription for ${customerId}`);
    newest.status = status;
  }

  /** Test helper: deleting the customer cancels its subscriptions and blocks further calls. */
  deleteCustomer(customerId: string) {
    this.requireCustomer(customerId);
    this.cancelAll(customerId);
    this.customers.delete(customerId);
  }

  /** Test helper: a webhook request this emulator's `parseWebhook` accepts. */
  signWebhook(event: object, timestamp = Math.floor(this.now() / 1000)) {
    const body = JSON.stringify(event);
    const headers = new Headers({
      "content-type": "application/json",
      "stripe-signature": signStripeWebhook(WEBHOOK_SECRET, body, timestamp),
    });
    return { body, headers };
  }

  /** Open checkouts go too, so none can start a subscription or purchase afterwards. */
  private cancelAll(customerId: string) {
    this.checkouts.delete(customerId);
    this.byokCheckouts.delete(customerId);
    this.creditCheckouts.delete(customerId);
    for (const subscription of this.forCustomer(customerId)) {
      if (subscription.status === "canceled") continue;
      subscription.status = "canceled";
      subscription.endedAt = new Date(this.now());
    }
  }

  private renewCredits(customerId: string) {
    for (const subscription of this.forCustomer(customerId)) {
      if (!subscription.creditAmountCents || subscription.status !== "active") continue;
      while (
        subscription.currentPeriodEndsAt &&
        subscription.currentPeriodEndsAt.getTime() <= this.now()
      ) {
        if (subscription.cancelAtPeriodEnd) {
          subscription.status = "canceled";
          subscription.endedAt = subscription.currentPeriodEndsAt;
          break;
        }
        subscription.currentPeriodStartsAt = subscription.currentPeriodEndsAt;
        subscription.currentPeriodEndsAt = new Date(
          subscription.currentPeriodEndsAt.getTime() + 30 * 86400000,
        );
        const purchases = this.creditPurchases.get(customerId) ?? [];
        purchases.push({
          id: `renewal_${this.namespace}_${++this.sequence}`,
          amountCents: subscription.creditAmountCents,
          expiresAt: subscription.currentPeriodEndsAt.toISOString(),
        });
        this.creditPurchases.set(customerId, purchases);
      }
    }
  }

  private forCustomer(customerId: string) {
    return this.subscriptions.filter((s) => s.customerId === customerId);
  }

  private requireCustomer(customerId: string) {
    if (!this.customers.has(customerId)) throw new BillingCustomerNotFoundError();
  }
}

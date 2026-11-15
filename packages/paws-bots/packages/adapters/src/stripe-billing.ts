import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
  BillingPaymentNotCompletedError,
} from "@rakazo/adapter-kit";
import type { BillingCancellationReason, ByokTier } from "@rakazo/contracts";
import {
  BILLING_CANCELLATION_REASONS,
  BYOK_TIERS,
  ByokTierSchema,
  HeldCreditAmountSchema,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";

export const STRIPE_API_VERSION = "2026-09-30.endive";
const WEBHOOK_TOLERANCE_SECONDS = 300;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5_000;
// Room for a 100-item list page with expanded objects.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId?: string;
  fetch?: typeof fetch;
  apiBase?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const priceSchema = z.object({
  unit_amount: z.number().int(),
  currency: z.string(),
  recurring: z.object({
    interval: z.enum(["day", "week", "month", "year"]),
    interval_count: z.number().int(),
  }),
});
const idSchema = z.object({ id: z.string().min(1) });
const urlSchema = z.object({ url: z.string().min(1) });
const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  created: z.number(),
  trial_end: z.number().nullish(),
  current_period_start: z.number().nullish(),
  current_period_end: z.number().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  cancel_at: z.number().nullish(),
  ended_at: z.number().nullish(),
  cancellation_details: z
    .object({ feedback: z.string().nullish(), comment: z.string().nullish() })
    .nullish(),
  default_payment_method: z
    .union([
      z.string(),
      z.object({ card: z.object({ fingerprint: z.string().nullish() }).nullish() }),
    ])
    .nullish(),
  items: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        quantity: z.number().int().nullish(),
        current_period_start: z.number().nullish(),
        current_period_end: z.number().nullish(),
        price: idSchema.extend({
          product: z.string().optional(),
          lookup_key: z.string().nullish(),
          unit_amount: z.number().int().nullish(),
          recurring: z
            .object({ interval: z.string(), interval_count: z.number().int().nullish() })
            .nullish(),
        }),
      }),
    ),
  }),
});
const subscriptionListSchema = z.object({
  data: z.array(subscriptionSchema),
  has_more: z.boolean(),
});
const checkoutListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
  has_more: z.boolean(),
});
const errorSchema = z.object({
  error: z.object({
    type: z.string().optional(),
    code: z.string().optional(),
    param: z.string().optional(),
    message: z.string().optional(),
  }),
});
type StripeSubscription = z.infer<typeof subscriptionSchema>;

class StripeRequestError extends Error {
  constructor(
    message: string,
    readonly type: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "StripeRequestError";
  }
}

/** Stripe REST wire format and credentials stay inside this adapter. */
export class StripeBillingProvider implements BillingProvider {
  private readonly config: StripeBillingConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly recurringPrices = new Map<string, string>();

  constructor(config: StripeBillingConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
    this.apiBase = config.apiBase ?? "https://api.stripe.com";
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  describe() {
    return {
      id: "stripe",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { trials: true, portal: true, modelCredits: true },
    };
  }

  async getPrice(): Promise<BillingPrice> {
    if (!this.config.priceId) throw new Error("Legacy subscription price is not configured");
    const price = priceSchema.parse(
      await this.request("GET", `/v1/prices/${encodeURIComponent(this.config.priceId)}`),
    );
    return {
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring.interval,
      intervalCount: price.recurring.interval_count,
    };
  }

  async createCustomer(input: { email: string; organizationId: string }) {
    const customer = idSchema.parse(
      await this.request("POST", "/v1/customers", {
        email: input.email,
        metadata: { organization_id: input.organizationId },
      }),
    );
    return { customerId: customer.id };
  }

  async createCheckout(input: BillingCheckoutRequest) {
    if (!this.config.priceId) throw new Error("Legacy subscription price is not configured");
    // An abandoned session has no subscription yet, so the access check still passes.
    // Expire it before opening another; a completed session is not open and stays paid once.
    await this.expireOpenCheckouts(input.customerId);
    // With no open session left, any checkout that completed since the caller's access check,
    // before or during the expiry, has already left its subscription behind.
    const live = await this.listSubscriptions(input.customerId);
    if (live.some((s) => holdsBillingSubscription(mapStripeSubscriptionStatus(s.status))))
      throw new BillingCheckoutCompletedError();
    const body = encodeStripeForm({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: this.config.priceId, quantity: input.seats }],
      payment_method_collection: "always",
      allow_promotion_codes: true,
      subscription_data: {
        billing_mode: { type: "classic" },
        ...(input.trialDays === undefined ? {} : { trial_period_days: input.trialDays }),
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    const session = urlSchema.parse(await this.request("POST", "/v1/checkout/sessions", body));
    return { url: session.url };
  }

  async createCreditCheckout(input: BillingCreditCheckoutRequest) {
    if (!ModelCreditAmountSchema.safeParse(input.amountCents).success)
      throw new Error("Invalid credit amount");
    if (input.monthly) {
      await this.expireOpenCheckouts(input.customerId);
      // Credits include the own-key plan, which sync ends once credits start.
      if (
        (await this.listSubscriptions(input.customerId)).some(
          (s) => !isByokPlan(s) && holdsBillingSubscription(mapStripeSubscriptionStatus(s.status)),
        )
      )
        throw new BillingCheckoutCompletedError();
    }
    const metadata = { rakazo_credit_cents: String(input.amountCents) };
    const session = urlSchema.parse(
      await this.request("POST", "/v1/checkout/sessions", {
        customer: input.customerId,
        mode: input.monthly ? "subscription" : "payment",
        allowed_payment_method_types: ["card"],
        // Credits are spent like cash; a bank-confirmed buyer moves fraud losses to the bank.
        payment_method_options: { card: { request_three_d_secure: "any" } },
        adaptive_pricing: { enabled: false },
        line_items: [
          input.monthly
            ? {
                quantity: 1,
                price: await this.recurringPrice(
                  `rakazo_monthly_credits_${input.amountCents}`,
                  input.amountCents,
                  "Rakazo monthly model credits",
                ),
              }
            : {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  unit_amount: input.amountCents,
                  product_data: { name: "Rakazo model credits" },
                },
              },
        ],
        metadata,
        ...(input.monthly
          ? { subscription_data: { metadata, billing_mode: { type: "classic" } } }
          : { payment_intent_data: { metadata }, invoice_creation: { enabled: true } }),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    );
    return { url: session.url };
  }

  async setMonthlyCredits(customerId: string, amountCents: number) {
    if (!ModelCreditAmountSchema.safeParse(amountCents).success)
      throw new Error("Invalid credit amount");
    const subscription = (await this.listSubscriptions(customerId)).find(
      (s) =>
        creditAmount(s.metadata?.rakazo_credit_cents) &&
        holdsBillingSubscription(mapStripeSubscriptionStatus(s.status)),
    );
    const item = subscription?.items.data[0];
    const previousAmount = creditAmount(subscription?.metadata?.rakazo_credit_cents);
    if (!subscription || !item || !previousAmount) throw new BillingNoMonthlyCreditsError();
    if (amountCents === previousAmount) return;
    const upgrading = amountCents > previousAmount;
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`, {
      items: [
        {
          id: item.id,
          price: await this.recurringPrice(
            `rakazo_monthly_credits_${amountCents}`,
            amountCents,
            "Rakazo monthly model credits",
          ),
          quantity: 1,
        },
      ],
      metadata: { rakazo_credit_cents: String(amountCents) },
      proration_behavior: upgrading ? "always_invoice" : "none",
      payment_behavior: "error_if_incomplete",
    }).catch(rethrowUncharged);
  }

  async createByokCheckout(input: BillingByokCheckoutRequest) {
    await this.expireOpenCheckouts(input.customerId);
    if (
      (await this.listSubscriptions(input.customerId)).some((s) =>
        holdsBillingSubscription(mapStripeSubscriptionStatus(s.status)),
      )
    )
      throw new BillingCheckoutCompletedError();
    const metadata = { [BYOK_PLAN_METADATA]: "byok" };
    const interval = input.interval ?? "month";
    const session = urlSchema.parse(
      await this.request("POST", "/v1/checkout/sessions", {
        customer: input.customerId,
        mode: "subscription",
        allowed_payment_method_types: ["card"],
        adaptive_pricing: { enabled: false },
        allow_promotion_codes: true,
        line_items: [
          {
            quantity: 1,
            price: await this.byokPrice({
              tier: input.tier ?? "standard",
              interval,
              amountCents: input.amountCents,
            }),
          },
        ],
        metadata,
        subscription_data: {
          metadata,
          billing_mode: { type: "classic" },
          ...(input.trialDays === undefined ? {} : { trial_period_days: input.trialDays }),
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    );
    return { url: session.url };
  }

  async changeByokPlan(
    customerId: string,
    subscriptionId: string,
    { from, to }: { from: BillingByokPlan; to: BillingByokPlan },
  ) {
    // Re-read just before charging: a credit checkout may have completed since the caller checked.
    const subscriptions = await this.listSubscriptions(customerId);
    const live = (s: StripeSubscription) =>
      holdsBillingSubscription(mapStripeSubscriptionStatus(s.status));
    const subscription = subscriptions.find((s) => s.id === subscriptionId);
    const item = subscription?.items.data[0];
    const status = subscription && mapStripeSubscriptionStatus(subscription.status);
    if (
      !subscription ||
      !item ||
      !isByokPlan(subscription) ||
      // Paid up and not cancelling: an overdue period must not be credited against the new plan.
      (status !== "active" && status !== "trialing") ||
      subscription.cancel_at_period_end ||
      subscription.cancel_at != null ||
      // Still the one plan the caller saw, as own-key checkout creates it.
      subscription.items.data.length !== 1 ||
      (item.quantity ?? 1) !== 1 ||
      item.price.recurring?.interval !== from.interval ||
      (item.price.recurring.interval_count ?? 1) !== 1 ||
      item.price.unit_amount !== from.amountCents ||
      byokTierOf(item.price.lookup_key) !== from.tier ||
      subscriptions.some((s) => live(s) && creditAmount(s.metadata?.rakazo_credit_cents))
    )
      return false;
    // A new interval restarts the billing cycle today; either way the unused part is credited.
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`, {
      items: [{ id: item.id, price: await this.byokPrice(to), quantity: 1 }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
    });
    return true;
  }

  /** The tier lives in the price's lookup key, so a plan changed in the billing portal keeps it. */
  private byokPrice({ tier, interval, amountCents }: BillingByokPlan) {
    const period = interval === "year" ? "yearly" : "monthly";
    // Standard keeps the keys its existing prices were created under.
    return this.recurringPrice(
      tier === "standard"
        ? `${BYOK_PRICE_KEY_PREFIX}${period}_${amountCents}`
        : `${BYOK_PRICE_KEY_PREFIX}${tier}_${period}_${amountCents}`,
      amountCents,
      tier === "standard"
        ? "Rakazo own-key plan"
        : `Rakazo own-key plan (${BYOK_TIERS[tier].name})`,
      interval,
    );
  }

  async endByokPlans(customerId: string) {
    for (const subscription of await this.listLiveSubscriptions(customerId)) {
      if (
        !isByokPlan(subscription) ||
        subscription.cancel_at_period_end ||
        subscription.cancel_at != null ||
        !holdsBillingSubscription(mapStripeSubscriptionStatus(subscription.status))
      )
        continue;
      try {
        await this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`, {
          cancel_at_period_end: true,
        });
      } catch (error) {
        await this.rethrowUnlessEnded(error, customerId, subscription.id);
      }
    }
  }

  private async recurringPrice(
    lookupKey: string,
    amountCents: number,
    productName: string,
    interval: "month" | "year" = "month",
  ): Promise<string> {
    const cached = this.recurringPrices.get(lookupKey);
    if (cached) return cached;
    const id = await this.findOrCreateRecurringPrice(lookupKey, amountCents, productName, interval);
    this.recurringPrices.set(lookupKey, id);
    return id;
  }

  private async findOrCreateRecurringPrice(
    lookupKey: string,
    amountCents: number,
    productName: string,
    interval: "month" | "year",
  ): Promise<string> {
    const query = encodeStripeForm({
      active: true,
      lookup_keys: [lookupKey],
      expand: ["data.product"],
    });
    const prices = z
      .object({
        data: z.array(
          idSchema.merge(priceSchema).extend({
            product: z.object({ active: z.boolean() }),
          }),
        ),
      })
      .parse(await this.request("GET", `/v1/prices?${query}`));
    const existing = prices.data.find(
      (price) =>
        price.product.active &&
        price.currency === "usd" &&
        price.unit_amount === amountCents &&
        price.recurring.interval === interval &&
        price.recurring.interval_count === 1,
    );
    if (existing) return existing.id;
    // Checkout's inline products are archived automatically; reusable plans need active products.
    return idSchema.parse(
      await this.request("POST", "/v1/prices", {
        currency: "usd",
        unit_amount: amountCents,
        recurring: { interval },
        product_data: { name: productName },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
      }),
    ).id;
  }

  /** Re-read settled payments and refund state; webhook payloads never grant money directly. */
  async listCreditPurchases(customerId: string): Promise<BillingCreditPurchase[]> {
    const customer = encodeURIComponent(customerId);
    const chargeSchema = z.object({
      id: z.string(),
      payment_intent: z.string().nullable(),
      currency: z.string(),
      paid: z.boolean(),
      captured: z.boolean(),
      disputed: z.boolean(),
      amount: z.number().int(),
      amount_refunded: z.number().int(),
    });
    const chargesPromise = this.listPages(`/v1/charges?customer=${customer}`, chargeSchema);
    const metadata = z.record(z.string(), z.string());
    const sessionsPromise = this.listPages(
      `/v1/checkout/sessions?customer=${customer}&status=complete`,
      z.object({
        id: z.string(),
        mode: z.string(),
        payment_status: z.string(),
        currency: z.string().nullable(),
        amount_total: z.number().nullable(),
        payment_intent: z.string().nullable(),
        metadata,
      }),
    );
    const creditLineSchema = z.object({
      amount: z.number().int(),
      discount_amounts: z.array(z.object({ amount: z.number().int().nonnegative() })).nullish(),
      period: z.object({ end: z.number().int().positive() }),
      parent: z
        .object({
          type: z.string(),
          subscription_item_details: z.object({ subscription: z.string() }).nullable().optional(),
        })
        .nullable()
        .optional(),
    });
    const invoicesPromise = this.listPages(
      `/v1/invoices?customer=${customer}&status=paid`,
      z.object({
        id: z.string(),
        currency: z.string(),
        amount_paid: z.number().int(),
        billing_reason: z.string().nullable(),
        lines: z
          .object({ data: z.array(creditLineSchema), has_more: z.boolean().optional() })
          .optional(),
        parent: z
          .object({
            subscription_details: z
              .object({ metadata, subscription: z.string().optional() })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    );
    const [charges, sessions, invoices] = await Promise.all([
      chargesPromise,
      sessionsPromise,
      invoicesPromise,
    ]);
    const netPaid = new Map<string, number>();
    for (const charge of charges) {
      if (!charge.payment_intent || charge.currency !== "usd" || !charge.paid || !charge.captured)
        continue;
      netPaid.set(
        charge.payment_intent,
        (netPaid.get(charge.payment_intent) ?? 0) +
          (charge.disputed ? 0 : Math.max(0, charge.amount - charge.amount_refunded)),
      );
    }
    const purchases: BillingCreditPurchase[] = [];
    for (const session of sessions) {
      const amount = creditAmount(session.metadata.rakazo_credit_cents);
      if (
        session.mode !== "payment" ||
        session.payment_status !== "paid" ||
        session.currency !== "usd" ||
        !amount ||
        session.amount_total !== amount ||
        !session.payment_intent
      )
        continue;
      purchases.push({
        id: session.id,
        amountCents: Math.min(amount, netPaid.get(session.payment_intent) ?? 0),
      });
    }
    for (const invoice of invoices) {
      const amount = creditAmount(
        invoice.parent?.subscription_details?.metadata.rakazo_credit_cents,
      );
      if (
        !amount ||
        invoice.currency !== "usd" ||
        !["subscription_create", "subscription_cycle", "subscription_update"].includes(
          invoice.billing_reason ?? "",
        ) ||
        invoice.amount_paid <= 0
      )
        continue;
      const [payments, lines] = await Promise.all([
        this.listPages(
          `/v1/invoice_payments?invoice=${encodeURIComponent(invoice.id)}&status=paid`,
          z.object({ payment: z.object({ payment_intent: z.string().optional() }) }),
        ),
        invoice.lines && !invoice.lines.has_more
          ? Promise.resolve(invoice.lines.data)
          : this.listPages(
              `/v1/invoices/${encodeURIComponent(invoice.id)}/lines`,
              creditLineSchema,
            ),
      ]);
      const paid = payments.reduce(
        (sum, payment) => sum + (netPaid.get(payment.payment.payment_intent ?? "") ?? 0),
        0,
      );
      const periods = lines.filter(
        (line) =>
          line.parent?.type === "subscription_item_details" &&
          Boolean(invoice.parent?.subscription_details?.subscription) &&
          line.parent.subscription_item_details?.subscription ===
            invoice.parent?.subscription_details?.subscription,
      );
      if (!periods.length) throw new Error("Monthly credit invoice has no service period");
      const expiresAt = fromSeconds(
        Math.max(...periods.map((line) => line.period.end)),
      )!.toISOString();
      const creditAmountCents = Math.max(
        0,
        periods.reduce(
          (sum, line) =>
            sum +
            line.amount -
            (line.discount_amounts ?? []).reduce((discount, item) => discount + item.amount, 0),
          0,
        ),
      );
      // Credits cover the subscription lines, excluding tax and other items. Refunds
      // reduce that paid portion proportionally because charges do not identify a line.
      const amountCents = Number(
        (BigInt(Math.min(creditAmountCents, invoice.amount_paid)) *
          BigInt(Math.min(paid, invoice.amount_paid))) /
          BigInt(invoice.amount_paid),
      );
      purchases.push({ id: invoice.id, amountCents, expiresAt });
    }
    return purchases;
  }

  private async listPages<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const rows: T[] = [];
    let after: string | undefined;
    for (;;) {
      const query = encodeStripeForm({ limit: 100, starting_after: after });
      const page = z
        .object({ data: z.array(schema.and(idSchema)), has_more: z.boolean() })
        .parse(await this.request("GET", `${path}${path.includes("?") ? "&" : "?"}${query}`));
      rows.push(...page.data);
      if (!page.has_more || !page.data.length) return rows;
      after = page.data.at(-1)!.id;
    }
  }

  async createPortal(input: { customerId: string; returnUrl: string }) {
    const session = urlSchema.parse(
      await this.request("POST", "/v1/billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      }),
    );
    return { url: session.url };
  }

  async getCustomerSubscription(customerId: string): Promise<BillingSubscriptionSnapshot | null> {
    const chosen = pickStripeSubscription(await this.listLiveSubscriptions(customerId));
    return chosen ? toSnapshot(chosen.subscription, chosen.status) : null;
  }

  async updateSeats(customerId: string, seats: number) {
    // Ended subscriptions refuse updates, as do incomplete ones from Checkout. Unpaid and paused
    // ones accept them, so they resume with the right seats.
    for (;;) {
      const chosen = pickStripeSubscription(await this.listLiveSubscriptions(customerId));
      if (!chosen || !holdsBillingSubscription(chosen.status)) return;
      if (
        creditAmount(chosen.subscription.metadata?.rakazo_credit_cents) ||
        isByokPlan(chosen.subscription)
      )
        return;
      const item = chosen.subscription.items.data[0];
      if (!item || item.quantity === seats) return;
      try {
        await this.request("POST", `/v1/subscription_items/${encodeURIComponent(item.id)}`, {
          quantity: seats,
          proration_behavior: "create_prorations",
        });
        return;
      } catch (error) {
        await this.rethrowUnlessEnded(error, customerId, chosen.subscription.id);
      }
    }
  }

  async endTrial(customerId: string) {
    const chosen = pickStripeSubscription(await this.listLiveSubscriptions(customerId));
    if (
      chosen?.status !== "trialing" ||
      toSnapshot(chosen.subscription, chosen.status).cancelAtPeriodEnd
    )
      return;
    // Bills the first period now. A card that is declined or needs confirming fails the request
    // with 402, and the trial runs on.
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(chosen.subscription.id)}`, {
      trial_end: "now",
      payment_behavior: "error_if_incomplete",
    }).catch(rethrowUncharged);
  }

  async cancelCustomerSubscriptions(customerId: string) {
    // First, so an abandoned checkout cannot start a subscription after the cancel.
    await this.expireOpenCheckouts(customerId).catch(ignoreDeletedCustomer);
    for (const subscription of await this.listLiveSubscriptions(customerId)) {
      // Only terminal states; unpaid and paused subscriptions can still resume and charge.
      if (mapStripeSubscriptionStatus(subscription.status) === "canceled") continue;
      try {
        await this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(subscription.id)}`);
      } catch (error) {
        await this.rethrowUnlessEnded(error, customerId, subscription.id);
      }
    }
  }

  async grantBalanceCredit(customerId: string, amountCents: number, referenceId: string) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      throw new Error("Invalid balance credit");
    const path = `/v1/customers/${encodeURIComponent(customerId)}/balance_transactions`;
    const granted = await this.listPages(
      path,
      z.object({ metadata: z.record(z.string(), z.string()).nullish() }),
    );
    if (granted.some((entry) => entry.metadata?.[BALANCE_REFERENCE_METADATA] === referenceId))
      return;
    // A fixed key only for this write: overlapping syncs must not both credit, and the lookup
    // above covers retries after Stripe has forgotten the key.
    await this.request(
      "POST",
      path,
      {
        amount: -amountCents,
        currency: "usd",
        description: "Referral reward",
        metadata: { [BALANCE_REFERENCE_METADATA]: referenceId },
      },
      `rakazo-balance-${referenceId}`,
    );
  }

  parseWebhook(rawBody: string, headers: Headers) {
    return parseStripeWebhook(this.config.webhookSecret, rawBody, headers, this.now());
  }

  async expireOpenCheckouts(customerId: string): Promise<void> {
    const seen = new Set<string>();
    for (;;) {
      const query = encodeStripeForm({ customer: customerId, status: "open", limit: 100 });
      const page = checkoutListSchema.parse(
        await this.request("GET", `/v1/checkout/sessions?${query}`),
      );
      const fresh = page.data.filter((session) => !seen.has(session.id));
      if (fresh.length === 0) return;
      for (const session of fresh) {
        seen.add(session.id);
        try {
          await this.request(
            "POST",
            `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`,
          );
        } catch (error) {
          // No longer open: it expired on its own or was just paid, which the caller rechecks.
          if (!(error instanceof StripeRequestError && error.type === "invalid_request_error"))
            throw error;
        }
      }
    }
  }

  /** A write Stripe refused because the subscription ended since it was read has nothing left to do. */
  private async rethrowUnlessEnded(error: unknown, customerId: string, subscriptionId: string) {
    if (!(error instanceof StripeRequestError && error.type === "invalid_request_error"))
      throw error;
    const fresh = (await this.listLiveSubscriptions(customerId)).find(
      (s) => s.id === subscriptionId,
    );
    if (fresh && mapStripeSubscriptionStatus(fresh.status) !== "canceled") throw error;
  }

  /** Deleting a customer cancels its subscriptions, so a deleted one has none left. */
  private listLiveSubscriptions(customerId: string): Promise<StripeSubscription[]> {
    return this.listSubscriptions(customerId).catch((error: unknown) => {
      ignoreDeletedCustomer(error);
      return [];
    });
  }

  private async listSubscriptions(customerId: string): Promise<StripeSubscription[]> {
    const all: StripeSubscription[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const query = encodeStripeForm({
        customer: customerId,
        status: "all",
        limit: 100,
        starting_after: startingAfter,
        expand: ["data.default_payment_method"],
      });
      const page = subscriptionListSchema.parse(
        await this.request("GET", `/v1/subscriptions?${query}`),
      );
      all.push(...page.data);
      const last = page.data.at(-1);
      if (!page.has_more || !last) return all;
      startingAfter = last.id;
    }
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown> | string,
    fixedIdempotencyKey?: string,
  ): Promise<unknown> {
    const body = typeof params === "string" ? params : params && encodeStripeForm(params);
    // One key per call: retries replay the first outcome, a later call starts fresh. Stripe
    // keeps a key's response, even a 500, for 24 hours, so a fixed key would wedge the call.
    const idempotencyKey = method === "POST" ? (fixedIdempotencyKey ?? randomUUID()) : undefined;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body,
      });
      const json: unknown = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES).catch(
        () => undefined,
      );
      if (response.ok) {
        if (json === undefined) throw new Error("Invalid Stripe response");
        return json;
      }
      if (attempt < MAX_RETRIES && shouldRetry(response)) {
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }
      const error = errorSchema.safeParse(json).data?.error;
      if (error?.code === "resource_missing" && error.param === "customer")
        throw new BillingCustomerNotFoundError();
      const message = error?.message?.replaceAll(this.config.secretKey, "[redacted]");
      throw new StripeRequestError(
        `Stripe request failed (${response.status})${message ? `: ${message}` : ""}`,
        error?.type,
        response.status,
      );
    }
  }
}

function ignoreDeletedCustomer(error: unknown): void {
  if (!(error instanceof BillingCustomerNotFoundError)) throw error;
}

/** Stripe's explicit hint wins; otherwise lock conflicts, rate limits and 5xx are transient. */
function shouldRetry(response: Response): boolean {
  const hint = response.headers.get("stripe-should-retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return response.status === 409 || response.status === 429 || response.status >= 500;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  const delay = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/** Stripe statuses collapse onto the provider-neutral set; `incomplete_expired` is terminal. */
export function mapStripeSubscriptionStatus(status: string): BillingSubscriptionStatus {
  if (
    status === "trialing" ||
    status === "active" ||
    status === "past_due" ||
    status === "incomplete" ||
    status === "unpaid" ||
    status === "paused"
  )
    return status;
  return "canceled";
}

/**
 * Prefers the newest subscription that grants access, then one that can still resume and charge
 * (so a later ended one cannot hide it), else the newest overall.
 */
export function pickBillingSubscription<
  T extends { status: BillingSubscriptionStatus; created: number },
>(subscriptions: T[]): T | undefined {
  const newestFirst = [...subscriptions].sort((a, b) => b.created - a.created);
  return (
    newestFirst.find((s) => grantsAccess(s.status)) ??
    newestFirst.find((s) => holdsBillingSubscription(s.status)) ??
    newestFirst[0]
  );
}

function pickStripeSubscription(subscriptions: StripeSubscription[]) {
  return pickBillingSubscription(
    subscriptions.map((subscription) => ({
      subscription,
      status: mapStripeSubscriptionStatus(subscription.status),
      created: subscription.created,
    })),
  );
}

function grantsAccess(status: BillingSubscriptionStatus) {
  return status === "trialing" || status === "active" || status === "past_due";
}

/** Grants access now or resumes once paid, so another checkout would bill twice. */
export function holdsBillingSubscription(status: BillingSubscriptionStatus) {
  return grantsAccess(status) || status === "unpaid" || status === "paused";
}

function toSnapshot(
  subscription: StripeSubscription,
  status: BillingSubscriptionStatus,
): BillingSubscriptionSnapshot {
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no items");
  const method = subscription.default_payment_method;
  const fingerprint = typeof method === "object" ? method?.card?.fingerprint : undefined;
  const reason = cancellationReason(subscription.cancellation_details?.feedback);
  const comment = subscription.cancellation_details?.comment?.trim();
  return {
    creditAmountCents: creditAmount(subscription.metadata?.rakazo_credit_cents),
    subscriptionId: subscription.id,
    subscriptionItemId: item.id,
    priceId: item.price.id,
    status,
    seats: item.quantity ?? 1,
    trialEndsAt: fromSeconds(subscription.trial_end),
    currentPeriodStartsAt: fromSeconds(
      item.current_period_start ?? subscription.current_period_start,
    ),
    currentPeriodEndsAt: fromSeconds(item.current_period_end ?? subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) || subscription.cancel_at != null,
    endedAt: fromSeconds(subscription.ended_at),
    ...(isByokPlan(subscription)
      ? {
          byokPlan: true,
          byokInterval: item.price.recurring?.interval === "year" ? "year" : "month",
          byokTier: byokTierOf(item.price.lookup_key),
          ...(item.price.unit_amount != null
            ? { byokPriceCents: item.price.unit_amount * (item.quantity ?? 1) }
            : {}),
        }
      : {}),
    ...(fingerprint ? { cardFingerprint: fingerprint } : {}),
    ...(reason ? { cancellationReason: reason } : {}),
    ...(comment ? { cancellationComment: comment } : {}),
  };
}

function cancellationReason(
  feedback: string | null | undefined,
): BillingCancellationReason | undefined {
  if (!feedback) return undefined;
  return BILLING_CANCELLATION_REASONS.find((reason) => reason === feedback) ?? "other";
}

function fromSeconds(value: number | null | undefined) {
  return value == null ? null : new Date(value * 1000);
}

/** Stripe's bracketed form encoding: `line_items[0][price]=...`. Undefined values are omitted. */
export function encodeStripeForm(params: Record<string, unknown>): string {
  const form = new URLSearchParams();
  const append = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const [i, entry] of value.entries()) append(`${key}[${i}]`, entry);
    } else if (typeof value === "object")
      for (const [k, v] of Object.entries(value)) append(`${key}[${k}]`, v);
    else form.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) append(key, value);
  return form.toString();
}

/** `stripe-signature` header value for `body` at `timestamp` (seconds). */
export function signStripeWebhook(secret: string, body: string, timestamp: number): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const syncEventTypes = new Set([
  "checkout.session.completed",
  "customer.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

/** Verifies a Stripe-signed webhook and extracts the customer to re-sync. */
export function parseStripeWebhook(
  secret: string,
  rawBody: string,
  headers: Headers,
  nowMs: number,
): { customerId: string } | "ignored" | null {
  const parts = (headers.get("stripe-signature") ?? "").split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  if (!Number.isFinite(timestamp)) return null;
  if (Math.abs(nowMs / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"),
  );
  const valid = parts.some(([key, value]) => {
    if (key !== "v1" || !value) return false;
    const candidate = Buffer.from(value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) return null;

  let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return "ignored";
  }
  const type = typeof event?.type === "string" ? event.type : "";
  if (!syncEventTypes.has(type) && !type.startsWith("customer.subscription.")) return "ignored";
  const object = event.data?.object;
  const customer = object?.object === "customer" ? object.id : object?.customer;
  const customerId =
    typeof customer === "string"
      ? customer
      : typeof (customer as { id?: unknown } | undefined)?.id === "string"
        ? (customer as { id: string }).id
        : undefined;
  return customerId ? { customerId } : "ignored";
}

export function stripeBillingConfigFromEnv(env: {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
}): StripeBillingConfig | undefined {
  const values = {
    STRIPE_SECRET_KEY: env.stripeSecretKey?.trim(),
    STRIPE_WEBHOOK_SECRET: env.stripeWebhookSecret?.trim(),
    STRIPE_PRICE_ID: env.stripePriceId?.trim(),
  };
  if (!Object.values(values).some(Boolean)) return undefined;
  const missing = Object.entries(values)
    .filter(([name, value]) => name !== "STRIPE_PRICE_ID" && !value)
    .map(([name]) => name);
  if (missing.length)
    throw new Error(`Stripe billing is partially configured; set ${missing.join(", ")}`);
  return {
    secretKey: values.STRIPE_SECRET_KEY!,
    webhookSecret: values.STRIPE_WEBHOOK_SECRET!,
    ...(values.STRIPE_PRICE_ID ? { priceId: values.STRIPE_PRICE_ID } : {}),
  };
}

const BYOK_PLAN_METADATA = "rakazo_plan";
const BALANCE_REFERENCE_METADATA = "rakazo_reference";

const BYOK_PRICE_KEY_PREFIX = "rakazo_byok_";

/** The tier named in an own-key price's lookup key; Standard's keys name none. */
export function byokTierOf(lookupKey: string | null | undefined): ByokTier {
  const named = lookupKey?.startsWith(BYOK_PRICE_KEY_PREFIX)
    ? lookupKey.slice(BYOK_PRICE_KEY_PREFIX.length).split("_")[0]
    : undefined;
  const parsed = ByokTierSchema.safeParse(named);
  return parsed.success ? parsed.data : "standard";
}

function isByokPlan(subscription: StripeSubscription) {
  return subscription.metadata?.[BYOK_PLAN_METADATA] === "byok";
}

function creditAmount(value: string | undefined): number | undefined {
  const parsed = HeldCreditAmountSchema.safeParse(Number(value));
  return parsed.success ? parsed.data : undefined;
}

/** Stripe answers 402 when `error_if_incomplete` leaves a declined or unconfirmed card uncharged. */
function rethrowUncharged(error: unknown): never {
  if (error instanceof StripeRequestError && error.status === 402)
    throw new BillingPaymentNotCompletedError({ cause: error });
  throw error;
}

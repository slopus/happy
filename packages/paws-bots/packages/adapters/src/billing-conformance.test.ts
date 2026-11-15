import type { BillingProvider, BillingSubscriptionStatus } from "@rakazo/adapter-kit";
import { BillingCheckoutCompletedError, BillingCustomerNotFoundError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { BillingEmulator } from "./billing-emulator.js";
import { StripeBillingProvider, signStripeWebhook } from "./stripe-billing.js";
import { StripeEmulator } from "./testing/stripe-emulator.js";

const NOW = Date.UTC(2026, 0, 1);
const now = () => NOW;

interface Harness {
  provider: BillingProvider;
  completeCheckout(customerId: string, status?: BillingSubscriptionStatus): void;
  setStatus(customerId: string, status: BillingSubscriptionStatus): void;
  deleteCustomer(customerId: string): void;
  sign(event: object, timestamp?: number): { body: string; headers: Headers };
}

const factories: Record<string, () => Harness> = {
  emulator() {
    const provider = new BillingEmulator({ now });
    return {
      provider,
      completeCheckout: (customerId, status) => provider.completeCheckout(customerId, status),
      setStatus: (customerId, status) => provider.setStatus(customerId, status),
      deleteCustomer: (customerId) => provider.deleteCustomer(customerId),
      sign: (event, timestamp) => provider.signWebhook(event, timestamp),
    };
  },
  "stripe-over-wire-emulator"() {
    const wire = new StripeEmulator({ now });
    const webhookSecret = "whsec_fake";
    const provider = new StripeBillingProvider({
      secretKey: wire.secretKey,
      webhookSecret,
      priceId: wire.priceId,
      fetch: wire.fetch,
      now,
    });
    return {
      provider,
      completeCheckout: (customerId, status) => wire.completeCheckout(customerId, status),
      setStatus: (customerId, status) => wire.setStatus(customerId, status),
      deleteCustomer: (customerId) => wire.deleteCustomer(customerId),
      sign(event, timestamp = Math.floor(NOW / 1000)) {
        const body = JSON.stringify(event);
        const headers = new Headers({
          "stripe-signature": signStripeWebhook(webhookSecret, body, timestamp),
        });
        return { body, headers };
      },
    };
  },
};

const urls = { successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };

async function subscribe(harness: Harness, trialDays?: number) {
  const { customerId } = await harness.provider.createCustomer({
    email: "owner@example.com",
    organizationId: "org_1",
  });
  const checkout = await harness.provider.createCheckout({
    customerId,
    seats: 3,
    trialDays,
    ...urls,
  });
  expect(checkout.url).toMatch(/^https:\/\//);
  harness.completeCheckout(customerId);
  return customerId;
}

for (const [name, create] of Object.entries(factories)) {
  describe(`${name} billing conformance (offline)`, () => {
    it("describes a recurring price", async () => {
      const { provider } = create();
      expect(provider.describe().capabilities).toMatchObject({ trials: true, portal: true });
      const price = await provider.getPrice();
      expect(price.amount).toBeGreaterThan(0);
      expect(price.currency).toMatch(/^[a-z]{3}$/);
      expect(["day", "week", "month", "year"]).toContain(price.interval);
      expect(price.intervalCount).toBeGreaterThanOrEqual(1);
    });

    it("starts a trial with the purchased seats and re-syncs idempotently", async () => {
      const harness = create();
      const customerId = await subscribe(harness, 14);
      const snapshot = await harness.provider.getCustomerSubscription(customerId);
      expect(snapshot).toMatchObject({
        status: "trialing",
        seats: 3,
        cancelAtPeriodEnd: false,
        endedAt: null,
      });
      expect(snapshot?.trialEndsAt?.getTime()).toBe(NOW + 14 * 86_400_000);
      expect(snapshot?.currentPeriodStartsAt?.getTime()).toBe(NOW);
      expect(snapshot?.currentPeriodEndsAt).toBeInstanceOf(Date);
      expect(await harness.provider.getCustomerSubscription(customerId)).toEqual(snapshot);
      expect(
        (await harness.provider.createPortal({ customerId, returnUrl: urls.successUrl })).url,
      ).toMatch(/^https:\/\//);
    });

    it("ends a trial early and starts the first paid period now", async () => {
      const harness = create();
      const customerId = await subscribe(harness, 14);
      await harness.provider.endTrial?.(customerId);
      const snapshot = await harness.provider.getCustomerSubscription(customerId);
      expect(snapshot?.status).toBe("active");
      expect(snapshot?.currentPeriodStartsAt?.getTime()).toBe(NOW);
      expect(snapshot?.currentPeriodEndsAt?.getTime()).toBeGreaterThan(NOW);
    });

    it("refuses a deleted customer with a classified error and reports no access", async () => {
      const harness = create();
      const customerId = await subscribe(harness);
      harness.deleteCustomer(customerId);
      const snapshot = await harness.provider.getCustomerSubscription(customerId);
      expect(snapshot?.status ?? "canceled").toBe("canceled");
      await expect(
        harness.provider.createCheckout({ customerId, seats: 1, ...urls }),
      ).rejects.toBeInstanceOf(BillingCustomerNotFoundError);
      await expect(
        harness.provider.createPortal({ customerId, returnUrl: urls.successUrl }),
      ).rejects.toBeInstanceOf(BillingCustomerNotFoundError);
      await harness.provider.cancelCustomerSubscriptions(customerId);
    });

    it("keeps unpaid and paused apart from canceled", async () => {
      for (const status of ["unpaid", "paused"] as const) {
        const harness = create();
        const customerId = await subscribe(harness);
        harness.setStatus(customerId, status);
        expect((await harness.provider.getCustomerSubscription(customerId))?.status).toBe(status);
      }
    });

    it("expires an open checkout when canceling", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_4",
      });
      await harness.provider.createCheckout({ customerId, seats: 1, ...urls });
      await harness.provider.cancelCustomerSubscriptions(customerId);
      expect(() => harness.completeCheckout(customerId)).toThrow();
    });

    it("replaces an unfinished checkout so only the latest one can be paid", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_3",
      });
      await harness.provider.createCheckout({ customerId, seats: 1, ...urls });
      await harness.provider.createCheckout({ customerId, seats: 4, trialDays: 14, ...urls });
      harness.completeCheckout(customerId);
      expect(await harness.provider.getCustomerSubscription(customerId)).toMatchObject({
        status: "trialing",
        seats: 4,
      });
    });

    it("expires every open checkout of the customer", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_3b",
      });
      await harness.provider.createCheckout({ customerId, seats: 1, ...urls });
      await harness.provider.expireOpenCheckouts(customerId);
      expect(() => harness.completeCheckout(customerId)).toThrow();
      await harness.provider.expireOpenCheckouts(customerId);
      await harness.provider.createCheckout({ customerId, seats: 2, ...urls });
      harness.completeCheckout(customerId);
      expect(await harness.provider.getCustomerSubscription(customerId)).toMatchObject({
        status: "active",
        seats: 2,
      });
    });

    it("is active immediately without a trial and returns null before any subscription", async () => {
      const harness = create();
      const { customerId } = await harness.provider.createCustomer({
        email: "owner@example.com",
        organizationId: "org_2",
      });
      expect(await harness.provider.getCustomerSubscription(customerId)).toBeNull();
      await harness.provider.createCheckout({ customerId, seats: 2, ...urls });
      harness.completeCheckout(customerId);
      expect(await harness.provider.getCustomerSubscription(customerId)).toMatchObject({
        status: "active",
        seats: 2,
        trialEndsAt: null,
      });
    });

    it("refuses another checkout while a subscription is held", async () => {
      for (const status of ["trialing", "past_due", "unpaid", "paused"] as const) {
        const harness = create();
        const customerId = await subscribe(harness);
        harness.setStatus(customerId, status);
        await expect(
          harness.provider.createCheckout({ customerId, seats: 5, ...urls }),
        ).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
      }
      const harness = create();
      const customerId = await subscribe(harness);
      harness.setStatus(customerId, "incomplete");
      await harness.provider.createCheckout({ customerId, seats: 5, ...urls });
    });

    it("updates seats and cancels", async () => {
      const harness = create();
      const customerId = await subscribe(harness);
      await harness.provider.updateSeats(customerId, 7);
      expect((await harness.provider.getCustomerSubscription(customerId))?.seats).toBe(7);
      await harness.provider.cancelCustomerSubscriptions(customerId);
      const canceled = await harness.provider.getCustomerSubscription(customerId);
      expect(canceled?.status).toBe("canceled");
      expect(canceled?.endedAt).toBeInstanceOf(Date);
      await harness.provider.cancelCustomerSubscriptions(customerId);
    });

    it("sets seats only while the subscription can still take updates", async () => {
      const cases: Array<[BillingSubscriptionStatus, number]> = [
        ["past_due", 7],
        ["unpaid", 7],
        ["paused", 7],
        ["incomplete", 3],
        ["canceled", 3],
      ];
      for (const [status, seats] of cases) {
        const harness = create();
        const customerId = await subscribe(harness);
        harness.setStatus(customerId, status);
        await harness.provider.updateSeats(customerId, 7);
        expect((await harness.provider.getCustomerSubscription(customerId))?.seats, status).toBe(
          seats,
        );
      }
    });

    it("verifies webhooks", () => {
      const { provider, sign } = create();
      const event = {
        type: "customer.subscription.updated",
        data: { object: { object: "subscription", customer: "cus_1" } },
      };
      const valid = sign(event);
      expect(provider.parseWebhook(valid.body, valid.headers)).toEqual({ customerId: "cus_1" });
      expect(provider.parseWebhook(valid.body.replace("cus_1", "cus_2"), valid.headers)).toBeNull();
      expect(provider.parseWebhook(valid.body, new Headers())).toBeNull();
      const stale = sign(event, Math.floor(NOW / 1000) - 301);
      expect(provider.parseWebhook(stale.body, stale.headers)).toBeNull();
      const checkout = sign({
        type: "checkout.session.completed",
        data: { object: { customer: { id: "cus_3" } } },
      });
      expect(provider.parseWebhook(checkout.body, checkout.headers)).toEqual({
        customerId: "cus_3",
      });
      const unrelated = sign({ type: "product.created", data: { object: { id: "prod_1" } } });
      expect(provider.parseWebhook(unrelated.body, unrelated.headers)).toBe("ignored");
    });
  });
}

describe("offline monthly credit renewals", () => {
  it("grants each paid period once across two renewals and keeps top-ups permanent", async () => {
    let timestamp = NOW;
    const provider = new BillingEmulator({ modelCredits: true, now: () => timestamp });
    const { customerId } = await provider.createCustomer({
      email: "billing@example.test",
      organizationId: "fixture",
    });
    const checkout = {
      customerId,
      amountCents: 1000,
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
    };
    await provider.createCreditCheckout({ ...checkout, monthly: true });
    provider.completeCreditCheckout(customerId);
    await provider.createCreditCheckout({ ...checkout, monthly: false });
    provider.completeCreditCheckout(customerId);
    const month = 30 * 86400000;
    timestamp += 2 * month;
    const purchases = await provider.listCreditPurchases(customerId);
    expect(purchases.filter((p) => p.expiresAt).map((p) => p.expiresAt)).toEqual([
      new Date(NOW + month).toISOString(),
      new Date(NOW + 2 * month).toISOString(),
      new Date(NOW + 3 * month).toISOString(),
    ]);
    expect(purchases.filter((p) => !p.expiresAt)).toHaveLength(1);
    expect(new Set(purchases.map((p) => p.id)).size).toBe(4);
    expect(await provider.listCreditPurchases(customerId)).toEqual(purchases);
    expect((await provider.getCustomerSubscription(customerId))?.currentPeriodEndsAt).toEqual(
      new Date(NOW + 3 * month),
    );
  });
});

describe("offline checkout cancellation", () => {
  it("expires every kind of open checkout session when canceling", async () => {
    const provider = new BillingEmulator({ modelCredits: true, now });
    const { customerId } = await provider.createCustomer({
      email: "billing@example.test",
      organizationId: "fixture",
    });
    const urls = {
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
    };
    await provider.createByokCheckout({ customerId, amountCents: 4900, ...urls });
    await provider.createCreditCheckout({ customerId, amountCents: 2000, monthly: true, ...urls });
    await provider.cancelCustomerSubscriptions(customerId);
    expect(() => provider.completeByokCheckout(customerId)).toThrow();
    expect(() => provider.completeCreditCheckout(customerId)).toThrow();
    expect(await provider.listCreditPurchases(customerId)).toEqual([]);
    expect(await provider.getCustomerSubscription(customerId)).toBeNull();
  });
});

describe("offline own-key tiers", () => {
  it("subscribes to a tier and moves to another only from the plan the caller saw", async () => {
    const provider = new BillingEmulator({ modelCredits: true, now });
    const { customerId } = await provider.createCustomer({
      email: "billing@example.test",
      organizationId: "fixture",
    });
    await provider.createByokCheckout({
      customerId,
      amountCents: 4900,
      tier: "pro",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
    });
    const subscriptionId = provider.completeByokCheckout(customerId);
    const subscribed = await provider.getCustomerSubscription(customerId);
    expect(subscribed).toMatchObject({ byokTier: "pro", byokPriceCents: 4900 });
    const pro = { tier: "pro", interval: "month", amountCents: 4900 } as const;
    const max = { tier: "max", interval: "month", amountCents: 14900 } as const;
    await expect(
      provider.changeByokPlan(customerId, subscriptionId, { from: max, to: pro }),
    ).resolves.toBe(false);
    await expect(
      provider.changeByokPlan(customerId, subscriptionId, { from: pro, to: max }),
    ).resolves.toBe(true);
    // The same interval keeps the period.
    expect(await provider.getCustomerSubscription(customerId)).toMatchObject({
      byokTier: "max",
      byokPriceCents: 14900,
      byokInterval: "month",
      currentPeriodEndsAt: subscribed?.currentPeriodEndsAt,
    });
  });
});

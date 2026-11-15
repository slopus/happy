import {
  BillingCheckoutCompletedError,
  BillingCustomerNotFoundError,
  BillingPaymentNotCompletedError,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  encodeStripeForm,
  mapStripeSubscriptionStatus,
  parseStripeWebhook,
  STRIPE_API_VERSION,
  StripeBillingProvider,
  signStripeWebhook,
  stripeBillingConfigFromEnv,
} from "./stripe-billing.js";
import type { StripeFailure } from "./testing/stripe-emulator.js";
import { StripeEmulator } from "./testing/stripe-emulator.js";

function setup(wrapFetch?: (wire: StripeEmulator) => typeof fetch) {
  const wire = new StripeEmulator();
  const sleeps: number[] = [];
  const provider = new StripeBillingProvider({
    secretKey: wire.secretKey,
    webhookSecret: "whsec_fake",
    priceId: wire.priceId,
    fetch: wrapFetch ? wrapFetch(wire) : wire.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { wire, provider, sleeps };
}

const urls = { successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };
const owner = { email: "owner@example.com", organizationId: "org_1" };

/** Builds a subscription history oldest first; a held one would refuse the next checkout. */
async function seedHistory(
  wire: StripeEmulator,
  provider: StripeBillingProvider,
  customerId: string,
  statuses: string[],
) {
  for (const _ of statuses) {
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId, "canceled");
  }
  for (const [i, status] of statuses.entries())
    wire.subscriptions.at(i - statuses.length)!.status = status;
}

describe("Stripe billing HTTP boundary", () => {
  it("encodes nested form keys and omits undefined values", () => {
    expect(
      decodeURIComponent(
        encodeStripeForm({ a: [{ price: "p", quantity: 2 }], b: { c: undefined }, d: true }),
      ),
    ).toBe("a[0][price]=p&a[0][quantity]=2&d=true");
  });

  it("sends the checkout shape with a fresh session per attempt and pinned version", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    expect(wire.requests.at(-1)!.form["metadata[organization_id]"]).toBe("org_1");

    await provider.createCheckout({ customerId, seats: 4, ...urls });
    const plain = wire.requests.at(-1)!;
    expect(STRIPE_API_VERSION).toBe("2026-09-30.endive");
    expect(plain.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(plain.form["subscription_data[billing_mode][type]"]).toBe("classic");
    expect(plain.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(plain.form).toMatchObject({
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": wire.priceId,
      "line_items[0][quantity]": "4",
      payment_method_collection: "always",
      allow_promotion_codes: "true",
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
    });
    expect(plain.form).not.toHaveProperty("subscription_data[trial_period_days]");

    await provider.createCheckout({ customerId, seats: 4, trialDays: 14, ...urls });
    expect(wire.requests.at(-1)!.form["subscription_data[trial_period_days]"]).toBe("14");
    expect(wire.sessions.map((session) => session.status)).toEqual(["expired", "open"]);
  });

  it("expires unfinished checkouts, including past the first page, and leaves a paid one", async () => {
    const { wire, provider } = setup();
    wire.pageSize = 1;
    const { customerId } = await provider.createCustomer(owner);
    for (const id of ["cs_old_1", "cs_old_2", "cs_old_3"]) {
      wire.sessions.push({
        id,
        customer: customerId,
        status: "open",
        form: { "line_items[0][price]": wire.priceId, "line_items[0][quantity]": "1" },
      });
    }
    const opened = await provider.createCheckout({ customerId, seats: 4, ...urls });
    expect(
      wire.sessions.filter((session) => session.status === "expired").map((s) => s.id),
    ).toEqual(["cs_old_1", "cs_old_2", "cs_old_3"]);
    const open = wire.sessions.filter((session) => session.status === "open");
    expect(open).toHaveLength(1);
    expect(opened.url).toBe(`https://checkout.stripe.com/c/pay/${open[0]!.id}`);
    wire.completeCheckout(customerId);
    expect(wire.subscriptions).toHaveLength(1);
    expect(wire.subscriptions[0]!.items.data[0]!.quantity).toBe(4);
    expect(() => wire.completeCheckout(customerId)).toThrow(/open checkout/);

    await expect(provider.createCheckout({ customerId, seats: 1, ...urls })).rejects.toBeInstanceOf(
      BillingCheckoutCompletedError,
    );
    expect(wire.requests.filter((request) => request.path.endsWith("/expire"))).toHaveLength(3);
    expect(wire.sessions.filter((session) => session.status === "open")).toHaveLength(0);
  });

  for (const { name, race, opens } of [
    { name: "opens the new checkout when an old one expired first", race: "expired", opens: true },
    {
      name: "refuses a new checkout when an old one was just paid",
      race: "complete",
      opens: false,
    },
  ] as const) {
    it(name, async () => {
      const { wire, provider } = setup((wire) => async (input, init) => {
        if (String(input).endsWith("/expire")) {
          const open = wire.sessions.find((session) => session.status === "open");
          if (open && race === "complete") wire.completeCheckout(open.customer);
          else if (open) open.status = "expired";
        }
        return wire.fetch(input, init);
      });
      const { customerId } = await provider.createCustomer(owner);
      await provider.createCheckout({ customerId, seats: 1, ...urls });
      const second = provider.createCheckout({ customerId, seats: 2, ...urls });
      if (opens) {
        const { url } = await second;
        expect(url).toBe(`https://checkout.stripe.com/c/pay/${wire.sessions.at(-1)!.id}`);
        expect(wire.sessions.map((session) => session.status)).toEqual(["expired", "open"]);
      } else {
        await expect(second).rejects.toBeInstanceOf(BillingCheckoutCompletedError);
        expect(wire.sessions.map((session) => session.status)).toEqual(["complete"]);
      }
    });
  }

  it("does not let a newer ended subscription hide one that can still resume", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await seedHistory(wire, provider, customerId, ["unpaid", "incomplete_expired"]);
    await expect(provider.getCustomerSubscription(customerId)).resolves.toMatchObject({
      status: "unpaid",
    });
  });

  it("reads every page of subscriptions", async () => {
    const { wire, provider } = setup();
    wire.pageSize = 2;
    const { customerId } = await provider.createCustomer(owner);
    await seedHistory(wire, provider, customerId, [
      "active",
      "canceled",
      "canceled",
      "canceled",
      "incomplete",
    ]);
    await expect(provider.getCustomerSubscription(customerId)).resolves.toMatchObject({
      status: "active",
    });
    await provider.cancelCustomerSubscriptions(customerId);
    expect(wire.subscriptions.every((s) => s.status === "canceled")).toBe(true);
  });

  it("cancels unpaid and paused subscriptions, which can still resume, and skips terminal ones", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await seedHistory(wire, provider, customerId, [
      "unpaid",
      "paused",
      "incomplete_expired",
      "canceled",
    ]);
    await provider.cancelCustomerSubscriptions(customerId);
    expect(wire.subscriptions.map((s) => s.status)).toEqual([
      "canceled",
      "canceled",
      "incomplete_expired",
      "canceled",
    ]);
    expect(wire.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
  });

  it("refuses item updates on an ended subscription, as Stripe does", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await seedHistory(wire, provider, customerId, ["canceled"]);
    const response = await wire.fetch(
      `https://api.stripe.com/v1/subscription_items/${wire.subscriptions[0]!.items.data[0]!.id}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${wire.secretKey}` },
        body: "quantity=7",
      },
    );
    expect(response.status).toBe(400);
    await provider.updateSeats(customerId, 7);
    expect(wire.requests.filter((r) => r.path.startsWith("/v1/subscription_items/"))).toHaveLength(
      1,
    );
  });

  it("sets seats on the live subscription when a newer one has ended", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await seedHistory(wire, provider, customerId, ["active", "canceled"]);
    await provider.updateSeats(customerId, 7);
    expect(wire.subscriptions.map((s) => s.items.data[0]!.quantity)).toEqual([7, 1]);
  });

  const writes = {
    seats: (provider: StripeBillingProvider, customerId: string) =>
      provider.updateSeats(customerId, 7),
    cancel: (provider: StripeBillingProvider, customerId: string) =>
      provider.cancelCustomerSubscriptions(customerId),
  };
  const isWrite = (path: string, init?: RequestInit) =>
    path.startsWith("/v1/subscription_items/") || init?.method === "DELETE";

  for (const [name, write] of Object.entries(writes)) {
    it(`treats a subscription canceled before the ${name} write lands as done`, async () => {
      const { wire, provider } = setup((wire) => async (input, init) => {
        if (isWrite(new URL(String(input)).pathname, init))
          wire.subscriptions[0]!.status = "canceled";
        return wire.fetch(input, init);
      });
      const { customerId } = await provider.createCustomer(owner);
      await seedHistory(wire, provider, customerId, ["active"]);
      await write(provider, customerId);
      expect(wire.requests.filter((r) => isWrite(r.path, r))).toHaveLength(1);
      expect(wire.subscriptions[0]!.items.data[0]!.quantity).toBe(1);
    });

    it(`surfaces a refused ${name} write on a subscription that is still live`, async () => {
      const { wire, provider } = setup((wire) => async (input, init) => {
        if (isWrite(new URL(String(input)).pathname, init))
          wire.failures.push({ status: 400, message: "Refused" });
        return wire.fetch(input, init);
      });
      const { customerId } = await provider.createCustomer(owner);
      await seedHistory(wire, provider, customerId, ["active"]);
      await expect(write(provider, customerId)).rejects.toThrow(/Refused/);
      expect(wire.requests.filter((r) => isWrite(r.path, r))).toHaveLength(1);
    });
  }

  it("expires open checkouts when canceling, so none can start a subscription later", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    await provider.cancelCustomerSubscriptions(customerId);
    expect(wire.sessions.map((session) => session.status)).toEqual(["expired"]);
    expect(() => wire.completeCheckout(customerId)).toThrow(/open checkout/);
  });

  it("keeps the trial when the early charge is declined or needs confirming", async () => {
    for (const failure of [
      { status: 402, type: "invalid_request_error", message: "requires additional user action" },
      { status: 402, type: "card_error", code: "card_declined", message: "declined" },
    ]) {
      const { wire, provider } = setup((wire) => async (input, init) => {
        if (init?.method === "POST" && String(init.body).includes("trial_end=now"))
          wire.failures.push(failure);
        return wire.fetch(input, init);
      });
      const { customerId } = await provider.createCustomer(owner);
      await provider.createCheckout({ customerId, seats: 1, trialDays: 7, ...urls });
      wire.completeCheckout(customerId);
      await expect(provider.endTrial(customerId)).rejects.toBeInstanceOf(
        BillingPaymentNotCompletedError,
      );
      expect(wire.subscriptions[0]!.status).toBe("trialing");
    }
  });

  it("maps Stripe statuses onto the neutral set", () => {
    for (const status of ["trialing", "active", "past_due", "incomplete", "unpaid", "paused"])
      expect(mapStripeSubscriptionStatus(status)).toBe(status);
    for (const status of ["canceled", "incomplete_expired"])
      expect(mapStripeSubscriptionStatus(status)).toBe("canceled");
  });

  it("reads the subscription's card fingerprint and credits the customer balance", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, trialDays: 7, ...urls });
    wire.completeCheckout(customerId, undefined, "fp_card_1");
    await expect(provider.getCustomerSubscription(customerId)).resolves.toMatchObject({
      status: "trialing",
      cardFingerprint: "fp_card_1",
    });
    await provider.grantBalanceCredit(customerId, 1000, "referral_1");
    await provider.grantBalanceCredit(customerId, 1000, "referral_1");
    expect(wire.balances.get(customerId)).toBe(-1000);
    // A credit Stripe made whose response was lost, retried after the idempotency key expired.
    wire.balanceTransactions.push({
      id: "cbtxn_lost",
      customer: customerId,
      amount: -1000,
      metadata: { rakazo_reference: "referral_2" },
    });
    await provider.grantBalanceCredit(customerId, 1000, "referral_2");
    expect(wire.balances.get(customerId)).toBe(-1000);
    await expect(provider.grantBalanceCredit(customerId, 0, "referral_3")).rejects.toThrow(
      /Invalid/,
    );
  });

  it("treats a scheduled cancellation as cancel at period end", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId);
    wire.subscriptions[0]!.cancel_at = 1_900_000_000;
    wire.setStatus(customerId, "unpaid");
    expect(await provider.getCustomerSubscription(customerId)).toMatchObject({
      status: "unpaid",
      cancelAtPeriodEnd: true,
    });
  });

  it("reads the cancellation survey answer", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId);
    wire.subscriptions[0]!.cancel_at_period_end = true;
    wire.subscriptions[0]!.cancellation_details = {
      feedback: "too_expensive",
      comment: " Pricey ",
    };
    expect(await provider.getCustomerSubscription(customerId)).toMatchObject({
      cancellationReason: "too_expensive",
      cancellationComment: "Pricey",
    });
    wire.subscriptions[0]!.cancellation_details = { feedback: "a_new_reason", comment: "  " };
    const snapshot = await provider.getCustomerSubscription(customerId);
    expect(snapshot?.cancellationReason).toBe("other");
    expect(snapshot).not.toHaveProperty("cancellationComment");
  });

  it("classifies a deleted customer without wedging", async () => {
    const { wire, provider } = setup();
    const { customerId } = await provider.createCustomer(owner);
    await provider.createCheckout({ customerId, seats: 1, ...urls });
    wire.completeCheckout(customerId);
    wire.deleteCustomer(customerId);
    expect(wire.subscriptions[0]!.status).toBe("canceled");

    await expect(provider.createCheckout({ customerId, seats: 1, ...urls })).rejects.toBeInstanceOf(
      BillingCustomerNotFoundError,
    );
    await expect(
      provider.createPortal({ customerId, returnUrl: urls.successUrl }),
    ).rejects.toBeInstanceOf(BillingCustomerNotFoundError);
    await expect(provider.getCustomerSubscription(customerId)).resolves.toBeNull();
    await expect(provider.cancelCustomerSubscriptions(customerId)).resolves.toBeUndefined();
  });

  it("uses a fresh idempotency key per call and the same one across its retries", async () => {
    const { wire, provider } = setup();
    // A fixed per-organization key would replay the first customer or reject the new email.
    await provider.createCustomer(owner);
    await provider.createCustomer({ ...owner, email: "new-owner@example.com" });
    expect(wire.customers.size).toBe(2);

    wire.failures.push({ status: 429, message: "Too many requests" });
    await provider.createPortal({ customerId: "cus_fake_1", returnUrl: urls.successUrl });
    const [limited, retried] = wire.requests.slice(-2);
    expect(retried!.headers.get("idempotency-key")).toBe(limited!.headers.get("idempotency-key"));
    const keys = wire.requests.map((r) => r.headers.get("idempotency-key"));
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(3);
  });

  it("replays a saved 500 to retries of the same call, and a later call starts fresh", async () => {
    const { wire, provider } = setup();
    wire.failures.push({ status: 500, message: "boom" });
    await expect(provider.createCustomer(owner)).rejects.toThrow("Stripe request failed (500)");
    expect(wire.requests).toHaveLength(3);
    expect(wire.customers.size).toBe(0);
    await expect(provider.createCustomer(owner)).resolves.toEqual({ customerId: "cus_fake_1" });
  });

  const retryCases: Array<{
    name: string;
    failures: StripeFailure[];
    attempts: number;
    sleeps: number[];
    ok: boolean;
  }> = [
    {
      name: "retries a rate limit with backoff",
      failures: [{ status: 429, message: "Too many requests" }],
      attempts: 2,
      sleeps: [500],
      ok: true,
    },
    {
      name: "honours Retry-After, capped",
      failures: [
        { status: 429, message: "slow", headers: { "Retry-After": "2" } },
        { status: 503, message: "busy", headers: { "Retry-After": "60" } },
      ],
      attempts: 3,
      sleeps: [2000, 5000],
      ok: true,
    },
    {
      name: "retries an error Stripe marks retryable",
      failures: [{ status: 400, message: "lock", headers: { "Stripe-Should-Retry": "true" } }],
      attempts: 2,
      sleeps: [500],
      ok: true,
    },
    {
      name: "does not retry when Stripe says not to",
      failures: [{ status: 500, message: "boom", headers: { "Stripe-Should-Retry": "false" } }],
      attempts: 1,
      sleeps: [],
      ok: false,
    },
    {
      name: "does not retry a plain client error",
      failures: [{ status: 400, message: "bad" }],
      attempts: 1,
      sleeps: [],
      ok: false,
    },
    {
      name: "gives up after a bounded number of attempts",
      failures: Array.from({ length: 5 }, () => ({ status: 429, message: "Too many requests" })),
      attempts: 3,
      sleeps: [500, 1000],
      ok: false,
    },
  ];
  for (const testCase of retryCases) {
    it(testCase.name, async () => {
      const { wire, provider, sleeps } = setup();
      wire.failures.push(...testCase.failures);
      const ok = await provider.getPrice().then(
        () => true,
        () => false,
      );
      expect(ok).toBe(testCase.ok);
      expect(wire.requests).toHaveLength(testCase.attempts);
      expect(sleeps).toEqual(testCase.sleeps);
    });
  }

  it("emulates Stripe replaying a key and rejecting it with different parameters", async () => {
    const { wire } = setup();
    const post = (email: string) =>
      wire.fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: { Authorization: `Bearer ${wire.secretKey}`, "Idempotency-Key": "k" },
        body: `email=${email}`,
      });
    const first = await (await post("a@example.com")).json();
    const replay = await post("a@example.com");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(first);
    const mismatch = await post("b@example.com");
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.type).toBe("idempotency_error");
    expect(wire.customers.size).toBe(1);
  });

  it("surfaces Stripe's error message without the secret key", async () => {
    const { wire, provider } = setup();
    wire.failures.push({ status: 400, message: `Bad key ${wire.secretKey} rejected` });
    const error = await provider.getPrice().then(
      () => new Error("expected failure"),
      (e: Error) => e,
    );
    expect(error.message).toBe("Stripe request failed (400): Bad key [redacted] rejected");
    expect(error.message).not.toContain(wire.secretKey);
  });

  it("does not read an oversized Stripe response", async () => {
    let cancel: unknown;
    const { provider } = setup((wire) => async (input, init) => {
      const response = await wire.fetch(input, init);
      const oversized = new Response(response.body, {
        status: response.status,
        headers: { "content-length": String(1024 * 1024 * 1024) },
      });
      cancel = vi.spyOn(oversized.body!, "cancel");
      return oversized;
    });
    await expect(provider.getPrice()).rejects.toThrow("Invalid Stripe response");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("re-syncs the customer when Stripe reports it deleted", () => {
    const now = Date.UTC(2026, 0, 1);
    const body = JSON.stringify({
      type: "customer.deleted",
      data: { object: { id: "cus_1", object: "customer", deleted: true } },
    });
    const headers = new Headers({
      "stripe-signature": signStripeWebhook("whsec_fake", body, now / 1000),
    });
    expect(parseStripeWebhook("whsec_fake", body, headers, now)).toEqual({ customerId: "cus_1" });
  });

  it("accepts any matching v1 signature and ignores malformed JSON", () => {
    const now = Date.UTC(2026, 0, 1);
    const t = now / 1000;
    const body = "not json";
    const valid = signStripeWebhook("whsec_fake", body, t).split(",")[1];
    const headers = new Headers({ "stripe-signature": `t=${t},v1=deadbeef,${valid}` });
    expect(parseStripeWebhook("whsec_fake", body, headers, now)).toBe("ignored");
    expect(parseStripeWebhook("whsec_other", body, headers, now)).toBeNull();
  });
});

describe("stripeBillingConfigFromEnv", () => {
  it("is disabled when unset and complete when all are set", () => {
    expect(stripeBillingConfigFromEnv({})).toBeUndefined();
    expect(
      stripeBillingConfigFromEnv({
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: "whsec_fake",
        stripePriceId: "price_fake",
      }),
    ).toEqual({ secretKey: "sk_test_fake", webhookSecret: "whsec_fake", priceId: "price_fake" });
  });

  it("supports model credits without a legacy seat price", () => {
    expect(
      stripeBillingConfigFromEnv({
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: "whsec_fake",
      }),
    ).toEqual({ secretKey: "sk_test_fake", webhookSecret: "whsec_fake" });
  });

  it("names the missing variables when partially configured", () => {
    expect(() => stripeBillingConfigFromEnv({ stripeSecretKey: "sk_test_fake" })).toThrow(
      "STRIPE_WEBHOOK_SECRET",
    );
  });
});

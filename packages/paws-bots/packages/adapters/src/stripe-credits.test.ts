import { BillingNoMonthlyCreditsError, BillingPaymentNotCompletedError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { byokTierOf, StripeBillingProvider } from "./stripe-billing.js";

const toYearly = {
  from: { tier: "standard", interval: "month", amountCents: 1500 },
  to: { tier: "standard", interval: "year", amountCents: 14400 },
} as const;

function fixture(routes: Record<string, unknown> = {}) {
  const requests: Array<{ path: string; params: URLSearchParams }> = [];
  const provider = new StripeBillingProvider({
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    priceId: "price_legacy",
    fetch: vi.fn(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, params: new URLSearchParams(String(init?.body ?? "")) });
      const route = routes[`${init?.method} ${url.pathname}`];
      if (route instanceof Response) return route;
      return Response.json(
        route ??
          routes[url.pathname] ??
          (url.pathname === "/v1/checkout/sessions" && init?.method === "POST"
            ? { url: "https://checkout.example.test/session" }
            : url.pathname === "/v1/prices" && init?.method === "POST"
              ? { id: "price_credits" }
              : { data: [], has_more: false }),
      );
    }),
  });
  return { provider, requests };
}
describe("Stripe prepaid model credits", () => {
  it("creates a monthly credit checkout without a trial or per-seat multiplication", async () => {
    const { provider, requests } = fixture();
    await provider.createCreditCheckout({
      customerId: "cus_fixture",
      amountCents: 2000,
      monthly: true,
      successUrl: "https://example.test/return",
      cancelUrl: "https://example.test/app",
    });
    const body = requests.at(-1)!.params;
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("allowed_payment_method_types[0]")).toBe("card");
    expect(body.has("payment_method_types[0]")).toBe(false);
    expect(body.get("subscription_data[billing_mode][type]")).toBe("classic");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("line_items[0][price]")).toBe("price_credits");
    expect(
      requests
        .find((r) => r.path === "/v1/prices" && r.params.has("unit_amount"))
        ?.params.get("unit_amount"),
    ).toBe("2000");
    expect(body.get("subscription_data[metadata][rakazo_credit_cents]")).toBe("2000");
    expect(body.has("subscription_data[trial_period_days]")).toBe(false);
  });
  it("creates top-ups as one-time payments without expiring other checkout sessions", async () => {
    const { provider, requests } = fixture();
    await provider.createCreditCheckout({
      customerId: "cus_fixture",
      amountCents: 2000,
      monthly: false,
      successUrl: "https://example.test/return",
      cancelUrl: "https://example.test/app",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.params.get("mode")).toBe("payment");
    expect(requests[0]!.params.get("allowed_payment_method_types[0]")).toBe("card");
    expect(requests[0]!.params.has("subscription_data[billing_mode][type]")).toBe(false);
    expect(requests[0]!.params.get("payment_intent_data[metadata][rakazo_credit_cents]")).toBe(
      "2000",
    );
  });
  it("asks the bank to confirm the buyer of every credit purchase", async () => {
    const { provider, requests } = fixture();
    for (const [amountCents, monthly] of [
      [2000, true],
      [2000, false],
    ] as const)
      await provider.createCreditCheckout({
        customerId: "cus_fixture",
        amountCents,
        monthly,
        successUrl: "https://example.test/return",
        cancelUrl: "https://example.test/app",
      });
    expect(
      requests
        .filter((r) => r.path === "/v1/checkout/sessions" && r.params.has("mode"))
        .map((r) => r.params.get("payment_method_options[card][request_three_d_secure]")),
    ).toEqual(["any", "any"]);
  });
  it("looks up a monthly price once, not on every checkout", async () => {
    const { provider, requests } = fixture();
    const checkout = () =>
      provider.createByokCheckout({
        customerId: "cus_fixture",
        amountCents: 1000,
        successUrl: "https://example.test/return",
        cancelUrl: "https://example.test/app",
      });
    const priceRequests = () => requests.filter((r) => r.path === "/v1/prices").length;
    await checkout();
    expect(priceRequests()).toBe(2);
    await checkout();
    expect(priceRequests()).toBe(2);
    expect(requests.at(-1)!.params.get("line_items[0][price]")).toBe("price_credits");
    expect(requests.at(-1)!.params.has("subscription_data[trial_period_days]")).toBe(false);
  });
  it("starts the own-key plan with a trial when one is requested", async () => {
    const { provider, requests } = fixture();
    await provider.createByokCheckout({
      customerId: "cus_fixture",
      amountCents: 1000,
      trialDays: 7,
      successUrl: "https://example.test/return",
      cancelUrl: "https://example.test/app",
    });
    expect(requests.at(-1)!.params.get("subscription_data[trial_period_days]")).toBe("7");
  });
  it("bills a yearly own-key plan on its own yearly price", async () => {
    const { provider, requests } = fixture();
    await provider.createByokCheckout({
      customerId: "cus_fixture",
      amountCents: 14400,
      interval: "year",
      successUrl: "https://example.test/return",
      cancelUrl: "https://example.test/app",
    });
    const created = requests.find((r) => r.path === "/v1/prices" && r.params.has("unit_amount"));
    expect(created?.params.get("recurring[interval]")).toBe("year");
    expect(created?.params.get("lookup_key")).toBe("rakazo_byok_yearly_14400");
  });
  it("names the tier in the price's lookup key, keeping Standard's keys", async () => {
    const { provider, requests } = fixture();
    await provider.createByokCheckout({
      customerId: "cus_fixture",
      amountCents: 4900,
      tier: "pro",
      successUrl: "https://example.test/return",
      cancelUrl: "https://example.test/app",
    });
    const created = requests.find((r) => r.path === "/v1/prices" && r.params.has("unit_amount"));
    expect(created?.params.get("lookup_key")).toBe("rakazo_byok_pro_monthly_4900");
    expect(created?.params.get("recurring[interval]")).toBe("month");
    expect(byokTierOf("rakazo_byok_pro_monthly_4900")).toBe("pro");
    expect(byokTierOf("rakazo_byok_max_yearly_142800")).toBe("max");
    expect(byokTierOf("rakazo_byok_monthly_1500")).toBe("standard");
    expect(byokTierOf("rakazo_byok_yearly_14400")).toBe("standard");
    expect(byokTierOf(null)).toBe("standard");
  });
  it("leaves a plan alone when it is not the live monthly plan, or credits have started", async () => {
    const plan = (
      id: string,
      status: string,
      metadata: Record<string, string>,
      interval = "month",
      unitAmount = 1500,
    ) => ({
      id,
      status,
      metadata,
      created: 1,
      items: {
        data: [
          {
            id: `si_${id}`,
            quantity: 1,
            price: { id: `price_${id}`, unit_amount: unitAmount, recurring: { interval } },
          },
        ],
      },
    });
    const { provider, requests } = fixture({
      "GET /v1/subscriptions": {
        data: [
          plan("sub_active", "active", { rakazo_plan: "byok" }),
          plan("sub_unpaid", "canceled", { rakazo_plan: "byok" }),
          plan("sub_yearly", "active", { rakazo_plan: "byok" }, "year"),
          plan("sub_overdue", "past_due", { rakazo_plan: "byok" }),
          plan("sub_cheap", "active", { rakazo_plan: "byok" }, "month", 1000),
          (() => {
            const quarterly = plan("sub_quarterly", "active", { rakazo_plan: "byok" });
            quarterly.items.data[0]!.price.recurring = {
              interval: "month",
              interval_count: 3,
            } as never;
            return quarterly;
          })(),
          (() => {
            const seats = plan("sub_seats", "active", { rakazo_plan: "byok" });
            seats.items.data[0]!.quantity = 2;
            return seats;
          })(),
          {
            ...plan("sub_cancelling", "active", { rakazo_plan: "byok" }),
            cancel_at_period_end: true,
          },
        ],
        has_more: false,
      },
    });
    await expect(provider.changeByokPlan("cus_fixture", "sub_unpaid", toYearly)).resolves.toBe(
      false,
    );
    for (const id of [
      "sub_yearly",
      "sub_overdue",
      "sub_cancelling",
      "sub_cheap",
      "sub_quarterly",
      "sub_seats",
    ])
      await expect(provider.changeByokPlan("cus_fixture", id, toYearly)).resolves.toBe(false);
    const withCredits = fixture({
      "GET /v1/subscriptions": {
        data: [
          plan("sub_active", "active", { rakazo_plan: "byok" }),
          plan("sub_credits", "active", { rakazo_credit_cents: "3000" }),
        ],
        has_more: false,
      },
    });
    await expect(
      withCredits.provider.changeByokPlan("cus_fixture", "sub_active", toYearly),
    ).resolves.toBe(false);
    for (const { path } of [...requests, ...withCredits.requests])
      expect(path).not.toMatch(/^\/v1\/subscriptions\/sub_/);
  });
  it("moves a monthly own-key plan to the yearly price, charging the difference now", async () => {
    const { provider, requests } = fixture({
      "GET /v1/subscriptions": {
        data: [
          {
            id: "sub_byok",
            status: "active",
            metadata: { rakazo_plan: "byok" },
            created: 1,
            items: {
              data: [
                {
                  id: "si_byok",
                  quantity: 1,
                  price: { id: "price_month", unit_amount: 1500, recurring: { interval: "month" } },
                },
              ],
            },
          },
        ],
        has_more: false,
      },
      "POST /v1/subscriptions/sub_byok": { id: "sub_byok" },
    });
    await expect(provider.changeByokPlan("cus_fixture", "sub_byok", toYearly)).resolves.toBe(true);
    const update = requests.find((r) => r.path === "/v1/subscriptions/sub_byok")!.params;
    expect(update.get("items[0][id]")).toBe("si_byok");
    expect(update.get("items[0][price]")).toBe("price_credits");
    expect(update.get("proration_behavior")).toBe("always_invoice");
    expect(update.get("payment_behavior")).toBe("error_if_incomplete");
    expect(
      requests
        .find((r) => r.path === "/v1/prices" && r.params.has("unit_amount"))
        ?.params.get("recurring[interval]"),
    ).toBe("year");
  });
  it("moves an own-key plan to another tier at its interval, and reports the tier", async () => {
    const subscription = (lookupKey: string, unitAmount: number) => ({
      id: "sub_byok",
      status: "active",
      metadata: { rakazo_plan: "byok" },
      created: 1,
      items: {
        data: [
          {
            id: "si_byok",
            quantity: 1,
            price: {
              id: "price_pro",
              unit_amount: unitAmount,
              lookup_key: lookupKey,
              recurring: { interval: "month" },
            },
          },
        ],
      },
    });
    const { provider, requests } = fixture({
      "GET /v1/subscriptions": {
        data: [subscription("rakazo_byok_pro_monthly_4900", 4900)],
        has_more: false,
      },
      "POST /v1/subscriptions/sub_byok": { id: "sub_byok" },
    });
    expect(await provider.getCustomerSubscription("cus_fixture")).toMatchObject({
      byokTier: "pro",
      byokPriceCents: 4900,
    });
    const change = {
      from: { tier: "pro", interval: "month", amountCents: 4900 },
      to: { tier: "max", interval: "month", amountCents: 14900 },
    } as const;
    // The caller saw a different plan than the provider has.
    await expect(
      provider.changeByokPlan("cus_fixture", "sub_byok", {
        ...change,
        from: { ...change.from, tier: "standard" },
      }),
    ).resolves.toBe(false);
    expect(requests.some((r) => r.path === "/v1/subscriptions/sub_byok")).toBe(false);
    await expect(provider.changeByokPlan("cus_fixture", "sub_byok", change)).resolves.toBe(true);
    const update = requests.find((r) => r.path === "/v1/subscriptions/sub_byok")!.params;
    expect(update.get("items[0][id]")).toBe("si_byok");
    expect(update.get("proration_behavior")).toBe("always_invoice");
    expect(update.get("payment_behavior")).toBe("error_if_incomplete");
    const created = requests.find((r) => r.path === "/v1/prices" && r.params.has("unit_amount"));
    expect(created?.params.get("lookup_key")).toBe("rakazo_byok_max_monthly_14900");
    expect(created?.params.get("recurring[interval]")).toBe("month");
  });
  it("reports the price an own-key subscription was bought at", async () => {
    const { provider } = fixture({
      "/v1/subscriptions": {
        data: [
          {
            id: "sub_byok",
            status: "active",
            metadata: { rakazo_plan: "byok" },
            created: 1,
            items: {
              data: [
                {
                  id: "si_byok",
                  quantity: 1,
                  price: { id: "price_old", unit_amount: 12000, recurring: { interval: "year" } },
                },
              ],
            },
          },
        ],
        has_more: false,
      },
    });
    await expect(provider.getCustomerSubscription("cus_fixture")).resolves.toMatchObject({
      byokPlan: true,
      byokPriceCents: 12000,
      byokInterval: "year",
    });
  });
  it("rejects invalid purchase amounts without contacting Stripe", async () => {
    const { provider, requests } = fixture();
    await expect(
      provider.createCreditCheckout({
        customerId: "cus_fixture",
        amountCents: 1,
        monthly: false,
        successUrl: "https://example.test/return",
        cancelUrl: "https://example.test/app",
      }),
    ).rejects.toThrow("Invalid credit amount");
    expect(requests).toHaveLength(0);
  });
  it("no longer sells retired amounts but still counts what was paid for them", async () => {
    const { provider, requests } = fixture({
      "/v1/charges": {
        data: [
          {
            id: "ch_retired",
            payment_intent: "pi_retired",
            currency: "usd",
            paid: true,
            captured: true,
            disputed: false,
            amount: 50000,
            amount_refunded: 0,
          },
        ],
        has_more: false,
      },
      "/v1/checkout/sessions": {
        data: [
          {
            id: "cs_retired",
            mode: "payment",
            payment_status: "paid",
            currency: "usd",
            amount_total: 50000,
            payment_intent: "pi_retired",
            metadata: { rakazo_credit_cents: "50000" },
          },
        ],
        has_more: false,
      },
    });
    await expect(
      provider.createCreditCheckout({
        customerId: "cus_fixture",
        amountCents: 50000,
        monthly: true,
        successUrl: "https://example.test/return",
        cancelUrl: "https://example.test/app",
      }),
    ).rejects.toThrow("Invalid credit amount");
    expect(requests).toHaveLength(0);
    expect(await provider.listCreditPurchases("cus_fixture")).toEqual([
      { id: "cs_retired", amountCents: 50000 },
    ]);
  });
  it("reads only settled credit payments, deducts refunds, and ignores legacy invoices", async () => {
    const { provider } = fixture({
      "/v1/charges": {
        data: [
          {
            id: "ch_1",
            payment_intent: "pi_1",
            currency: "usd",
            paid: true,
            captured: true,
            disputed: false,
            amount: 2000,
            amount_refunded: 500,
          },
        ],
        has_more: false,
      },
      "/v1/checkout/sessions": {
        data: [
          {
            id: "cs_1",
            mode: "payment",
            payment_status: "paid",
            currency: "usd",
            amount_total: 2000,
            payment_intent: "pi_1",
            metadata: { rakazo_credit_cents: "2000" },
          },
          {
            id: "cs_unpaid",
            mode: "payment",
            payment_status: "unpaid",
            currency: "usd",
            amount_total: 2000,
            payment_intent: "pi_2",
            metadata: { rakazo_credit_cents: "2000" },
          },
        ],
        has_more: false,
      },
      "/v1/invoices": {
        data: [
          {
            id: "in_legacy",
            currency: "usd",
            amount_paid: 1200,
            billing_reason: "subscription_cycle",
            lines: {
              data: [
                {
                  amount: 1000,
                  period: { end: 2_000_000_000 },
                  metadata: { rakazo_credit_cents: "1000" },
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: { subscription: "sub_credit_fixture" },
                  },
                },
              ],
            },
            parent: null,
          },
        ],
        has_more: false,
      },
    });
    expect(await provider.listCreditPurchases("cus_fixture")).toEqual([
      { id: "cs_1", amountCents: 1500 },
    ]);
  });
  it("uses only credit subscription periods and does not double-count their checkout session", async () => {
    const { provider } = fixture({
      "/v1/charges": {
        data: [
          {
            id: "ch_1",
            payment_intent: "pi_1",
            currency: "usd",
            paid: true,
            captured: true,
            disputed: false,
            amount: 1000,
            amount_refunded: 0,
          },
        ],
        has_more: false,
      },
      "/v1/checkout/sessions": {
        data: [
          {
            id: "cs_monthly",
            mode: "subscription",
            payment_status: "paid",
            currency: "usd",
            amount_total: 1000,
            payment_intent: null,
            metadata: { rakazo_credit_cents: "1000" },
          },
        ],
        has_more: false,
      },
      "/v1/invoices": {
        data: [
          {
            id: "in_1",
            currency: "usd",
            amount_paid: 1000,
            billing_reason: "subscription_cycle",
            lines: {
              data: [
                {
                  amount: 1000,
                  period: { end: 2_000_000_000 },
                  metadata: { rakazo_credit_cents: "1000" },
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: { subscription: "sub_credit_fixture" },
                  },
                },
                {
                  amount: 2000,
                  period: { end: 2_100_000_000 },
                  metadata: {},
                  parent: { type: "invoice_item_details" },
                },
                {
                  amount: 3000,
                  period: { end: 2_200_000_000 },
                  metadata: {},
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: { subscription: "sub_other" },
                  },
                },
              ],
            },
            parent: {
              subscription_details: {
                subscription: "sub_credit_fixture",
                metadata: { rakazo_credit_cents: "1000" },
              },
            },
          },
        ],
        has_more: false,
      },
      "/v1/invoice_payments": {
        data: [{ id: "inpay_1", payment: { payment_intent: "pi_1" } }],
        has_more: false,
      },
    });
    expect(await provider.listCreditPurchases("cus_fixture")).toEqual([
      { id: "in_1", amountCents: 1000, expiresAt: "2033-05-18T03:33:20.000Z" },
    ]);
  });
  function subscription(amount: number) {
    return {
      data: [
        {
          id: "sub_fixture",
          status: "active",
          created: 1,
          metadata: { rakazo_credit_cents: String(amount) },
          items: {
            data: [{ id: "si_fixture", price: { id: "price_old", product: "prod_archived" } }],
          },
        },
      ],
      has_more: false,
    };
  }
  it("charges upgrades immediately using an active reusable price and refuses incomplete payment", async () => {
    const { provider, requests } = fixture({ "/v1/subscriptions": subscription(1000) });
    await provider.setMonthlyCredits("cus_fixture", 2000);
    const body = requests.at(-1)!.params;
    expect(body.get("items[0][id]")).toBe("si_fixture");
    expect(body.get("items[0][price]")).toBe("price_credits");
    expect(body.get("proration_behavior")).toBe("always_invoice");
    expect(body.get("payment_behavior")).toBe("error_if_incomplete");
    expect(body.get("metadata[rakazo_credit_cents]")).toBe("2000");
    expect(requests.find((r) => r.params.has("product_data[name]"))?.params.get("lookup_key")).toBe(
      "rakazo_monthly_credits_2000",
    );
  });
  it("names a change to an ended monthly plan as having no plan to change", async () => {
    const ended = subscription(1000);
    ended.data[0]!.status = "canceled";
    const { provider, requests } = fixture({ "/v1/subscriptions": ended });
    await expect(provider.setMonthlyCredits("cus_fixture", 2000)).rejects.toBeInstanceOf(
      BillingNoMonthlyCreditsError,
    );
    expect(requests.some((r) => r.path === "/v1/subscriptions/sub_fixture")).toBe(false);
  });
  it("names a declined upgrade as a payment that was not completed", async () => {
    const { provider } = fixture({
      "/v1/subscriptions": subscription(1000),
      "POST /v1/subscriptions/sub_fixture": Response.json(
        { error: { type: "card_error", code: "card_declined", message: "declined" } },
        { status: 402 },
      ),
    });
    await expect(provider.setMonthlyCredits("cus_fixture", 2000)).rejects.toBeInstanceOf(
      BillingPaymentNotCompletedError,
    );
  });
  it("changes the renewal price without a charge or proration when downgrading", async () => {
    const { provider, requests } = fixture({ "/v1/subscriptions": subscription(3000) });
    await provider.setMonthlyCredits("cus_fixture", 2000);
    expect(requests.at(-1)!.params.get("proration_behavior")).toBe("none");
  });
  it("reuses a matching active plan instead of Checkout's archived inline product", async () => {
    const { provider, requests } = fixture({
      "/v1/subscriptions": subscription(1000),
      "GET /v1/prices": {
        data: [
          {
            id: "price_reusable",
            currency: "usd",
            unit_amount: 2000,
            recurring: { interval: "month", interval_count: 1 },
            product: { active: true },
          },
        ],
      },
    });
    await provider.setMonthlyCredits("cus_fixture", 2000);
    expect(requests.some((r) => r.params.has("product_data[name]"))).toBe(false);
    expect(requests.at(-1)!.params.get("items[0][price]")).toBe("price_reusable");
  });
  it("grants the money actually collected for a prorated upgrade, once per invoice", async () => {
    const { provider } = fixture({
      "/v1/charges": {
        data: [
          {
            id: "ch_upgrade",
            payment_intent: "pi_upgrade",
            currency: "usd",
            paid: true,
            captured: true,
            disputed: false,
            amount: 999,
            amount_refunded: 0,
          },
        ],
        has_more: false,
      },
      "/v1/invoices": {
        data: [
          {
            id: "in_upgrade",
            currency: "usd",
            amount_paid: 999,
            billing_reason: "subscription_update",
            lines: {
              data: [
                {
                  amount: -1001,
                  period: { end: 2_000_000_000 },
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: { subscription: "sub_credit_fixture" },
                  },
                },
                {
                  amount: 2000,
                  period: { end: 2_000_000_000 },
                  metadata: { rakazo_credit_cents: "1000" },
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: { subscription: "sub_credit_fixture" },
                  },
                },
              ],
            },
            parent: {
              subscription_details: {
                subscription: "sub_credit_fixture",
                metadata: { rakazo_credit_cents: "2000" },
              },
            },
          },
        ],
        has_more: false,
      },
      "/v1/invoice_payments": {
        data: [{ id: "inpay_upgrade", payment: { payment_intent: "pi_upgrade" } }],
        has_more: false,
      },
    });
    expect(await provider.listCreditPurchases("cus_fixture")).toEqual([
      { id: "in_upgrade", amountCents: 999, expiresAt: "2033-05-18T03:33:20.000Z" },
    ]);
  });
  it.each([
    { label: "tax", paid: 1100, refund: 0, other: 0, expected: 1000 },
    { label: "tax and a partial refund", paid: 1100, refund: 550, other: 0, expected: 500 },
    { label: "another invoice item", paid: 3000, refund: 0, other: 2000, expected: 1000 },
    { label: "a discount", paid: 800, refund: 0, other: 0, discount: 200, expected: 800 },
  ])(
    "credits only the model portion with $label",
    async ({ paid, refund, other, expected, ...input }) => {
      const { provider } = fixture({
        "/v1/charges": {
          data: [
            {
              id: "ch_credit",
              payment_intent: "pi_credit",
              currency: "usd",
              paid: true,
              captured: true,
              disputed: false,
              amount: paid,
              amount_refunded: refund,
            },
          ],
          has_more: false,
        },
        "/v1/invoices": {
          data: [
            {
              id: "in_credit",
              currency: "usd",
              amount_paid: paid,
              billing_reason: "subscription_cycle",
              parent: {
                subscription_details: {
                  subscription: "sub_credit",
                  metadata: { rakazo_credit_cents: "1000" },
                },
              },
              lines: {
                data: [
                  {
                    amount: 1000,
                    discount_amounts: input.discount ? [{ amount: input.discount }] : null,
                    period: { end: 2_000_000_000 },
                    parent: {
                      type: "subscription_item_details",
                      subscription_item_details: { subscription: "sub_credit" },
                    },
                  },
                  {
                    amount: other,
                    period: { end: 2_000_000_000 },
                    parent: { type: "invoice_item_details" },
                  },
                ],
              },
            },
          ],
          has_more: false,
        },
        "/v1/invoice_payments": {
          data: [{ id: "inpay_credit", payment: { payment_intent: "pi_credit" } }],
          has_more: false,
        },
      });
      expect(await provider.listCreditPurchases("cus_fixture")).toEqual([
        { id: "in_credit", amountCents: expected, expiresAt: "2033-05-18T03:33:20.000Z" },
      ]);
    },
  );
});

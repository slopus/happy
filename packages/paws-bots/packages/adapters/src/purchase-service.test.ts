import type { AdapterContext } from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import { Challenge, Credential } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_PAY_TOKEN,
  FAKE_SHARED_PAYMENT_TOKEN,
  FakePaymentWallet,
  fakeJobs,
  fakePurchasePrisma,
} from "./fake-purchases.js";
import { executePaidRequest, paidRequestEffect, restorePaidRequest } from "./paid-request.js";
import {
  executePurchaseTool,
  loadPurchaseRedactions,
  resolvePurchaseCardFill,
  resolvePurchasePayTokenFill,
} from "./purchase-service.js";

vi.mock("./payment-wallets.js", () => ({
  withPaymentWalletCredential: async (
    _deps: unknown,
    _actor: unknown,
    fn: (credential: { secret: string; refreshAt: null }) => Promise<unknown>,
  ) => fn({ secret: "credential", refreshAt: null }),
}));

const fixture = { spaceId: "space-1", userId: "user-1", botId: "bot-1", threadId: "thread-1" };
const request = {
  merchantName: "Example Store",
  merchantUrl: "https://shop.example.test/checkout",
  amount: 1999,
  currency: "USD",
  reason: "Two boxes of printer paper for the office, as the user asked this morning. ".repeat(2),
};

function setup(paidRequestFetch?: typeof fetch) {
  const db = fakePurchasePrisma(fixture);
  const queue = fakeJobs();
  const wallet = new FakePaymentWallet();
  const secrets = new Map<string, string>();
  const secretStore = {
    put: async (plaintext: string) => {
      const ref = `sealed-${secrets.size + 1}`;
      secrets.set(ref, plaintext);
      return { id: ref, ref, ciphertext: ref };
    },
    load: async (ref: string) => secrets.get(ref)!,
    delete: async (ref: string) => {
      secrets.delete(ref);
    },
  } as never;
  const deps = {
    prisma: db.prisma,
    secretStore,
    jobs: queue.jobs,
    paymentWallet: wallet,
    paidRequestFetch: {
      fetch: paidRequestFetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    },
  };
  const context = (operationId = "op-1"): AdapterContext & { botId: string } => ({
    operationId,
    traceId: operationId,
    spaceId: fixture.spaceId,
    userId: fixture.userId,
    botId: fixture.botId,
    signal: new AbortController().signal,
  });
  const call = (name: string, args: Record<string, unknown>, operationId?: string) =>
    executePurchaseTool(deps, context(operationId), { threadId: fixture.threadId }, name, args);
  const paid = (args: Record<string, unknown>, operationId?: string) =>
    executePaidRequest(deps, context(operationId), { threadId: fixture.threadId }, args);
  return { ...db, ...queue, wallet, deps, call, paid, secrets };
}

describe("request_purchase", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it("asks the wallet owner, records the purchase and schedules a poll", async () => {
    const result = await env.call("request_purchase", request);
    expect(env.wallet.created).toEqual([
      expect.objectContaining({ amount: 1999, currency: "usd", idempotencyKey: "op-1" }),
    ]);
    expect(result).toMatchObject({
      id: "purchase-1",
      status: "pending_approval",
      merchantUrl: request.merchantUrl,
      amount: 1999,
      currency: "usd",
      approvalUrl: "https://wallet.example.test/approve/remote-op-1",
    });
    expect(env.purchases[0]).toMatchObject({
      operationKey: "op-1",
      remoteId: "remote-op-1",
      provider: "fake",
      wokenStatus: "pending_approval",
    });
    expect(env.purchases[0]!.nextPollAt).toBeInstanceOf(Date);
    expect(env.enqueued.map((job) => job.name)).toEqual(["purchase.poll"]);
  });

  it("returns the recorded purchase when the call replays", async () => {
    const first = await env.call("request_purchase", request);
    const second = await env.call("request_purchase", request);
    expect(second).toEqual(first);
    expect(env.wallet.created).toHaveLength(1);
    expect(env.purchases).toHaveLength(1);
  });

  it("rejects invalid input before reaching the wallet", async () => {
    const result = await env.call("request_purchase", {
      ...request,
      merchantUrl: "http://shop.example.test",
      reason: "too short",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("merchantUrl") });
    expect(env.wallet.created).toHaveLength(0);
  });

  it("tells the bot to have the user connect the wallet when it is disconnected", async () => {
    env.wallet.createPurchase = async () => {
      throw new PaymentWalletDisconnected();
    };
    const result = await env.call("request_purchase", request);
    expect(result).toEqual({ error: expect.stringContaining("Settings") });
    expect(env.purchases).toHaveLength(0);
  });

  it("passes the provider's safe rejection message through", async () => {
    env.wallet.createPurchase = async () => {
      throw new PaymentWalletRequestRejected("The amount is over the wallet's limit.");
    };
    expect(await env.call("request_purchase", request)).toEqual({
      error: "The amount is over the wallet's limit.",
    });
  });

  it("is unavailable without a wallet", async () => {
    const result = await executePurchaseTool(
      { ...env.deps, paymentWallet: null },
      {
        operationId: "op",
        traceId: "op",
        spaceId: fixture.spaceId,
        userId: fixture.userId,
        botId: fixture.botId,
        signal: new AbortController().signal,
      },
      { threadId: fixture.threadId },
      "request_purchase",
      request,
    );
    expect(result).toHaveProperty("error");
  });
});

describe("request_purchase with a spending limit", () => {
  const limit = { amount: 5_000, currency: "usd", period: "week", startsAt: new Date(0) } as const;

  it("counts the purchase before the wallet owner is asked, and refuses one that goes over", async () => {
    const env = setup();
    env.spending.limit = { ...limit };
    await env.call("request_purchase", request);
    expect(env.spending.payments).toEqual([
      expect.objectContaining({
        operationKey: "op-1",
        site: "shop.example.test",
        amount: 1999,
        currency: "usd",
        releasedAt: null,
      }),
    ]);
    const over = await env.call("request_purchase", { ...request, amount: 3002 }, "op-2");
    expect(over).toEqual({
      error:
        "This would go over the user's spending limit of $50.00 a week ($19.99 spent), so nothing was paid. Don't retry; tell the user.",
    });
    expect(env.wallet.created).toHaveLength(1);
  });

  it("refuses a purchase in another currency than the limit", async () => {
    const env = setup();
    env.spending.limit = { ...limit };
    const result = await env.call("request_purchase", { ...request, currency: "cad" });
    expect(result).toEqual({ error: expect.stringContaining("couldn't be read in USD") });
    expect(env.wallet.created).toHaveLength(0);
  });

  it("keeps counting a purchase whose request failed without an answer", async () => {
    const env = setup();
    env.spending.limit = { ...limit };
    env.wallet.createPurchase = async () => {
      throw new Error("socket hang up");
    };
    await expect(env.call("request_purchase", request)).rejects.toThrow("socket hang up");
    expect(env.spending.payments).toEqual([
      expect.objectContaining({ operationKey: "op-1", releasedAt: null }),
    ]);
  });

  it("stops counting a purchase the wallet refused or the owner denied", async () => {
    const env = setup();
    env.spending.limit = { ...limit };
    env.wallet.createPurchase = async () => {
      throw new PaymentWalletRequestRejected("Not available.");
    };
    await env.call("request_purchase", request);
    expect(env.spending.payments).toEqual([
      expect.objectContaining({ operationKey: "op-1", releasedAt: expect.any(Date) }),
    ]);

    const denied = setup();
    denied.spending.limit = { ...limit };
    await denied.call("request_purchase", request);
    denied.wallet.snapshots.set("remote-op-1", { id: "remote-op-1", status: "denied" });
    await denied.call("purchase_status", { id: "purchase-1" });
    expect(denied.spending.payments).toEqual([
      expect.objectContaining({ operationKey: "op-1", releasedAt: expect.any(Date) }),
    ]);
  });
});

describe("purchase_status", () => {
  it("shows the card summary once approved and never the number or code", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.wallet.snapshots.set("remote-op-1", {
      id: "remote-op-1",
      status: "approved",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034 },
    });
    const result = await env.call("purchase_status", { id: "purchase-1" });
    expect(result).toMatchObject({
      status: "approved",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2034 },
      next: expect.stringContaining("fill_card"),
    });
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
    // The bot saw this status itself, so the poller does not wake it for it again.
    expect(env.purchases[0]).toMatchObject({
      status: "approved",
      wokenStatus: "approved",
      nextPollAt: null,
    });
  });

  it("only finds this user's purchases in this space", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.purchases[0]!.userId = "someone-else";
    expect(await env.call("purchase_status", { id: "purchase-1" })).toEqual({
      error: "Unknown purchase.",
    });
  });
});

describe("resolvePurchaseCardFill", () => {
  it("returns the value, its merchant origin and the number to redact", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    const scope = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "number")).toEqual({
      error: expect.stringContaining("not approved"),
    });
    env.purchases[0]!.status = "approved";
    const number = await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "number");
    expect(number).toEqual({
      text: "4242424242424242",
      origin: "https://shop.example.test",
      redactions: ["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242"],
    });
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "cvc")).toMatchObject({
      text: "123",
      origin: "https://shop.example.test",
    });
    expect(
      await resolvePurchaseCardFill(
        env.deps,
        { ...scope, userId: "someone-else" },
        "purchase-1",
        "cvc",
      ),
    ).toEqual({ error: "Unknown purchase." });
    // Another bot of the same user can't type it: its runs would not keep hiding the card.
    expect(
      await resolvePurchaseCardFill(env.deps, { ...scope, botId: "bot-2" }, "purchase-1", "cvc"),
    ).toEqual({ error: "Unknown purchase." });
  });

  it("types the expiry as digits and the billing postal code from the approved card", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    const scope = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    env.purchases[0]!.status = "approved";
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "expiry")).toEqual({
      error: expect.stringContaining("not approved"),
    });
    const summary = { brand: "visa", last4: "4242", expMonth: 3, expYear: 2034 };
    env.wallet.snapshots.set("remote-op-1", {
      id: "remote-op-1",
      status: "approved",
      card: summary,
    });
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "expiry")).toEqual({
      text: "03/34",
      origin: "https://shop.example.test",
      redactions: [],
    });
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "postal_code")).toEqual({
      error: "This card has no billing postal code.",
    });
    env.wallet.snapshots.set("remote-op-1", {
      id: "remote-op-1",
      status: "approved",
      card: {
        ...summary,
        billingAddress: {
          name: "Test User",
          line1: "1 Test St",
          postalCode: " 94110 ",
          country: "US",
        },
      },
    });
    expect(
      await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "postal_code"),
    ).toMatchObject({ text: "94110", origin: "https://shop.example.test" });
    // Neither detail reveals the card, so nothing is sealed for later runs to hide.
    expect(env.purchases[0]!.cardCiphertext ?? null).toBeNull();
  });

  it("keeps hiding a typed card in the bot's later runs, sealed at rest", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    const run = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    expect(await loadPurchaseRedactions(env.deps, run)).toEqual([]);
    env.purchases[0]!.status = "approved";
    await resolvePurchaseCardFill(env.deps, run, "purchase-1", "number");
    await resolvePurchaseCardFill(env.deps, run, "purchase-1", "cvc");
    expect(env.purchases[0]!.cardCiphertext).toBe("sealed-1");
    expect(env.secrets.size).toBe(1);
    expect(await loadPurchaseRedactions(env.deps, run)).toEqual([
      "4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
    ]);
    expect(await loadPurchaseRedactions(env.deps, { ...run, botId: "bot-2" })).toEqual([]);
  });

  it("deletes a sealed card that two first fills raced to save", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.purchases[0]!.status = "approved";
    const run = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };
    await Promise.all([
      resolvePurchaseCardFill(env.deps, run, "purchase-1", "number"),
      resolvePurchaseCardFill(env.deps, run, "purchase-1", "cvc"),
    ]);
    expect(env.secrets.size).toBe(1);
    expect(env.secrets.has(env.purchases[0]!.cardCiphertext!)).toBe(true);
  });
});

describe("pay token purchases", () => {
  const scope = { spaceId: fixture.spaceId, userId: fixture.userId, botId: fixture.botId };

  it("asks for a pay token for the merchant account and hands it only to the page fill", async () => {
    const env = setup();
    const result = await env.call("request_purchase", {
      ...request,
      merchantAccountId: "acct_fake123",
    });
    expect(env.wallet.created[0]).toMatchObject({
      credential: { kind: "pay_token", merchantAccountId: "acct_fake123" },
      amount: 1999,
    });
    expect(result).toMatchObject({ status: "pending_approval", merchantUrl: request.merchantUrl });
    expect(env.purchases[0]).toMatchObject({
      credentialType: "pay_token",
      merchantAccountId: "acct_fake123",
    });
    expect(await resolvePurchasePayTokenFill(env.deps, scope, "purchase-1")).toEqual({
      error: expect.stringContaining("not approved"),
    });

    env.wallet.snapshots.set("remote-op-1", { id: "remote-op-1", status: "approved" });
    const status = await env.call("purchase_status", { id: "purchase-1" });
    expect(status).toMatchObject({
      status: "approved",
      next: expect.stringContaining("fill_pay_token"),
    });
    expect(JSON.stringify(status)).not.toContain(FAKE_PAY_TOKEN);
    expect(await resolvePurchaseCardFill(env.deps, scope, "purchase-1", "number")).toEqual({
      error: expect.stringContaining("without a card"),
    });
    expect(
      await resolvePurchasePayTokenFill(env.deps, { ...scope, botId: "bot-2" }, "purchase-1"),
    ).toEqual({ error: "Unknown purchase." });
    expect(await resolvePurchasePayTokenFill(env.deps, scope, "purchase-1")).toEqual({
      text: FAKE_PAY_TOKEN,
      origin: "https://shop.example.test",
      merchantAccountId: "acct_fake123",
      redactions: [FAKE_PAY_TOKEN],
    });
    expect(await loadPurchaseRedactions(env.deps, scope)).toEqual([FAKE_PAY_TOKEN]);
  });

  it("refuses a pay token fill for a card purchase", async () => {
    const env = setup();
    await env.call("request_purchase", request);
    env.purchases[0]!.status = "approved";
    expect(await resolvePurchasePayTokenFill(env.deps, scope, "purchase-1")).toEqual({
      error: expect.stringContaining("no pay token"),
    });
  });
});

describe("paid_request", () => {
  const url = "https://api.example.test/v1/forecast?city=paris";
  const paidArgs = {
    url,
    method: "post",
    headers: { "content-type": "application/json" },
    body: '{"days":3}',
    reason:
      "A three day weather forecast for Paris from the paid weather API, which the user asked for this morning to plan their trip next week.",
  };

  /** An MPP API charging 500 cents per call; `echo` makes it repeat the request's credentials. */
  function paidApi(
    options: {
      amount?: string;
      method?: string;
      status?: number;
      echo?: boolean;
      pad?: number;
    } = {},
  ) {
    let issued = 0;
    const seen: { method: string; body: string | null; authorization: string | null }[] = [];
    const api = {
      seen,
      amount: options.amount ?? "500",
      status: options.status ?? 200,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        seen.push({
          method: String(init?.method),
          body: (init?.body as string) ?? null,
          authorization,
        });
        if (authorization) {
          const credential = Credential.deserialize<{ spt: string }>(authorization);
          if (credential.challenge.id !== `challenge-${issued}`)
            return new Response("stale", { status: 402 });
          const body = options.echo
            ? `${"x".repeat(options.pad ?? 0)}paid with ${credential.payload.spt} via ${authorization}`
            : '{"forecast":"sun"}';
          return new Response(body, {
            status: api.status,
            headers: { "content-type": "application/json" },
          });
        }
        issued += 1;
        return new Response("Payment required", {
          status: 402,
          headers: {
            "www-authenticate": Challenge.serialize({
              id: `challenge-${issued}`,
              realm: "api.example.test",
              method: options.method ?? "stripe",
              intent: "charge",
              request: {
                amount: api.amount,
                currency: "usd",
                methodDetails: { networkId: "net_fake" },
              },
            }),
          },
        });
      }) as typeof fetch,
    };
    return api;
  }

  async function approvedPurchase(api = paidApi()) {
    const env = setup(api.fetch);
    const asked = await env.paid(paidArgs);
    env.wallet.snapshots.set("remote-op-1", { id: "remote-op-1", status: "approved" });
    return { env, api, asked };
  }

  it("asks the wallet owner for the amount the server's challenge names and seals the request", async () => {
    const { env, api, asked } = await approvedPurchase();
    expect(asked.result).toMatchObject({
      id: "purchase-1",
      status: "pending_approval",
      amount: 500,
      currency: "usd",
      merchantName: "api.example.test",
      merchantUrl: "https://api.example.test/v1/forecast",
    });
    expect(env.wallet.created[0]).toMatchObject({
      credential: { kind: "http_payment" },
      amount: 500,
      currency: "usd",
    });
    expect(api.seen).toEqual([{ method: "POST", body: '{"days":3}', authorization: null }]);
    const row = env.purchases[0]!;
    expect(row).toMatchObject({ credentialType: "http_payment", amount: 500 });
    expect(JSON.parse(env.secrets.get(row.requestCiphertext!)!)).toEqual({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"days":3}',
    });
    expect(JSON.stringify(row)).not.toContain("days");

    expect((await env.paid(paidArgs)).result).toEqual(asked.result);
    expect(env.purchases).toHaveLength(1);
  });

  it("sends the request again with the payment once approved, only once", async () => {
    const { env, api } = await approvedPurchase();
    const paid = await env.paid({ purchase: "purchase-1" }, "op-2");
    expect(paid.result).toMatchObject({
      purchase: { id: "purchase-1", status: "completed" },
      status: 200,
      body: '{"forecast":"sun"}',
    });
    expect(api.seen.at(-1)).toMatchObject({ method: "POST", body: '{"days":3}' });
    expect(api.seen.at(-1)!.authorization).toMatch(/^Payment /);
    expect(paid.redactions).toContain(FAKE_SHARED_PAYMENT_TOKEN);
    expect(env.purchases[0]).toMatchObject({ status: "completed", nextPollAt: null });
    expect(await loadPurchaseRedactions(env.deps, fixture)).toContain(FAKE_SHARED_PAYMENT_TOKEN);
    expect((await env.paid({ purchase: "purchase-1" }, "op-3")).result).toEqual({
      error: expect.stringContaining("already used"),
    });
  });

  it("keeps payment credentials a server echoes out of the result", async () => {
    const { env } = await approvedPurchase(paidApi({ echo: true }));
    const paid = await env.paid({ purchase: "purchase-1" }, "op-2");
    expect(JSON.stringify(paid.result)).not.toContain(FAKE_SHARED_PAYMENT_TOKEN);
    expect(JSON.stringify(paid.result)).not.toMatch(/Payment ey/);
  });

  it("hides a token the response limit would cut in half", async () => {
    const { env } = await approvedPurchase(paidApi({ echo: true, pad: 50_000 - 20 }));
    const paid = await env.paid({ purchase: "purchase-1" }, "op-2");
    const body = String((paid.result as { body: string }).body);
    expect(body).not.toContain(FAKE_SHARED_PAYMENT_TOKEN.slice(0, 8));
  });

  it("logs only a digest of a paid request's headers and body", () => {
    const effect = paidRequestEffect(paidArgs);
    expect(effect).toMatchObject({ url: paidArgs.url, method: "post", sealed: expect.any(String) });
    expect(JSON.stringify(effect)).not.toContain("days");
    expect(JSON.stringify(effect)).not.toContain("content-type");
    expect(paidRequestEffect({ purchase: "purchase-1" })).toEqual({ purchase: "purchase-1" });
  });

  it("resumes an approved request only with the headers and body that were approved", () => {
    const approved = paidRequestEffect(paidArgs);
    expect(restorePaidRequest(approved, paidArgs)).toEqual(paidArgs);
    expect(restorePaidRequest(approved, { ...paidArgs, body: '{"days":30}' })).toEqual({
      error: expect.stringContaining("changed after approval"),
    });
    expect(restorePaidRequest({ purchase: "purchase-1" }, {})).toEqual({ purchase: "purchase-1" });
  });

  it("marks the purchase failed when the paid request is refused", async () => {
    const { env } = await approvedPurchase(paidApi({ status: 500 }));
    const paid = await env.paid({ purchase: "purchase-1" }, "op-2");
    expect(paid.result).toMatchObject({ purchase: { status: "failed" }, status: 500 });
    expect(env.purchases[0]).toMatchObject({ status: "failed", wokenStatus: "failed" });
  });

  it("does not pay a challenge whose amount changed after approval", async () => {
    const { env, api } = await approvedPurchase();
    api.amount = "5000";
    expect((await env.paid({ purchase: "purchase-1" }, "op-2")).result).toEqual({
      error: expect.stringContaining("changed after approval"),
    });
    expect(api.seen.every((call) => !call.authorization)).toBe(true);
    expect(env.purchases[0]!.status).toBe("approved");
  });

  it("waits for the owner's approval", async () => {
    const env = setup(paidApi().fetch);
    await env.paid(paidArgs);
    expect((await env.paid({ purchase: "purchase-1" }, "op-2")).result).toMatchObject({
      status: "pending_approval",
    });
  });

  it("returns a response that asks for no payment, and pays no other method", async () => {
    const free = setup((async () => new Response("free", { status: 200 })) as typeof fetch);
    expect((await free.paid(paidArgs)).result).toMatchObject({ status: 200, body: "free" });
    expect(free.purchases).toHaveLength(0);

    const other = setup(paidApi({ method: "tempo" }).fetch);
    expect((await other.paid(paidArgs)).result).toMatchObject({
      status: 402,
      error: expect.stringContaining("can't pay"),
    });
    expect(other.wallet.created).toHaveLength(0);
  });

  it("refuses credentials, plain HTTP and private hosts before sending anything", async () => {
    const api = paidApi();
    const env = setup(api.fetch);
    expect(
      (await env.paid({ ...paidArgs, headers: { Authorization: "Bearer fake-key" } })).result,
    ).toEqual({ error: expect.stringContaining("Credentials") });
    expect((await env.paid({ ...paidArgs, url: "http://api.example.test/" })).result).toEqual({
      error: expect.stringContaining("HTTPS"),
    });
    env.deps.paidRequestFetch.resolveHostname = async () => [{ address: "10.0.0.5", family: 4 }];
    expect((await env.paid(paidArgs)).result).toEqual({ error: expect.any(String) });
    expect(api.seen).toHaveLength(0);
  });
});

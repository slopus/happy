import type {
  AdapterContext,
  PaymentWalletCredential,
  PaymentWalletProvider,
  PurchaseRequest,
} from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import { Challenge, Credential } from "mppx";
import { describe, expect, it, vi } from "vitest";
import { LinkWalletProvider } from "./link-wallet.js";
import { EmulatorPaymentWalletProvider } from "./payment-wallet-emulator.js";

const ctx: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

const reason =
  "Buy one ticket for the community theater show on Friday evening, as requested in chat by the owner.";

function purchase(overrides: Partial<PurchaseRequest> = {}): PurchaseRequest {
  return {
    credential: {
      kind: "card",
      merchantName: "Example Theater",
      merchantUrl: "https://tickets.example.com/checkout",
    },
    amount: 2500,
    currency: "usd",
    reason,
    idempotencyKey: "op-1",
    ...overrides,
  };
}

async function connect(provider: PaymentWalletProvider): Promise<PaymentWalletCredential> {
  const start = await provider.beginConnect({ clientName: "Rakazo" }, ctx);
  expect(start.verificationUrl).toMatch(/^https:\/\//);
  expect(start.userCode).toBeTruthy();
  expect(start.expiresAt.getTime()).toBeGreaterThan(Date.now());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await provider.pollConnect(start.state, ctx);
    if (result.status === "connected") return result.credential;
    expect(result.status).toBe("pending");
  }
  throw new Error("Sign-in never completed.");
}

/** A fake of Link's device-flow and spend-request endpoints. */
function fakeLink() {
  const state = {
    tokenPolls: 0,
    tokenResponse: null as null | { status: number; body: unknown },
    access: new Map<string, string>(),
    refresh: new Set<string>(),
    revoked: [] as string[],
    created: [] as Record<string, unknown>[],
    requests: new Map<
      string,
      { status: string; amount: number; reads: number; credentialType: string }
    >(),
    nextCreate: null as null | { status: number; body: unknown },
    nextRetrieve: null as null | Record<string, unknown>,
    sequence: 0,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const issue = () => {
    state.sequence += 1;
    const access = `fake-access-${state.sequence}`;
    const refresh = `fake-refresh-${state.sequence}`;
    state.access.set(access, refresh);
    state.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" };
  };
  const spendRequest = (id: string, include: string | null) => {
    const request = state.requests.get(id)!;
    const approved = request.status === "approved";
    const type = request.credentialType;
    return {
      id,
      status: request.status,
      amount: request.amount,
      currency: "usd",
      credential_type: type,
      created_at: "2026-10-27T00:00:00Z",
      updated_at: "2026-10-27T00:00:00Z",
      approval_url: `https://app.link.com/approve/${id}`,
      ...(approved && type === "card" ? { card_brand: "visa", card_last4: "4242" } : {}),
      ...(approved && type === "link_pay_token" && include === "link_pay_token"
        ? { link_pay_token: "lpt_fake_secret" }
        : {}),
      ...(approved && type === "shared_payment_token" && include === "shared_payment_token"
        ? { shared_payment_token: { id: "spt_fake_link_secret" } }
        : {}),
      ...(approved && type === "card" && include === "card"
        ? {
            card: {
              id: "card_1",
              brand: "visa",
              number: "4242424242424242",
              cvc: "123",
              exp_month: 12,
              exp_year: 2034,
              billing_address: {
                name: "Test User",
                line1: "1 Test Street",
                postal_code: "94107",
                country: "US",
              },
            },
          }
        : {}),
    };
  };

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === "https://login.link.com") {
      const form = new URLSearchParams(String(init?.body));
      if (url.pathname === "/device/code") {
        expect(form.get("scope")).toBe("userinfo:read payment_methods.agentic");
        return json(200, {
          device_code: "fake-device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.link.com/device",
          verification_uri_complete: "https://app.link.com/device?code=ABCD-EFGH",
          expires_in: 300,
          interval: 5,
        });
      }
      if (url.pathname === "/device/token") {
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token")!;
          if (!state.refresh.has(token)) return json(400, { error: "invalid_grant" });
          state.refresh.delete(token);
          return json(200, issue());
        }
        if (state.tokenResponse) return json(state.tokenResponse.status, state.tokenResponse.body);
        state.tokenPolls += 1;
        if (state.tokenPolls === 1) return json(400, { error: "authorization_pending" });
        return json(200, issue());
      }
      if (url.pathname === "/device/revoke") {
        const token = form.get("token")!;
        state.revoked.push(token);
        state.refresh.delete(token);
        for (const [access, refresh] of state.access) {
          if (refresh === token) state.access.delete(access);
        }
        return new Response(null, { status: 200 });
      }
    }
    if (url.origin === "https://api.link.com" && url.pathname.startsWith("/spend_requests")) {
      const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
      if (!bearer || !state.access.has(bearer)) {
        return json(401, { error: { message: "fake-secret-body token expired" } });
      }
      if (method === "POST" && url.pathname === "/spend_requests") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        state.created.push(body);
        if (state.nextCreate) {
          const next = state.nextCreate;
          state.nextCreate = null;
          return json(next.status, next.body);
        }
        const existing = [...state.requests.keys()].find(
          (id) => id === `lsrq_${body.idempotency_key}`,
        );
        if (existing) {
          return json(400, {
            error: {
              code: "duplicate_spend_request",
              duplicate_spend_request: spendRequest(existing, null),
            },
          });
        }
        const id = `lsrq_${body.idempotency_key}`;
        state.requests.set(id, {
          status: "pending_approval",
          amount: Number(body.amount),
          reads: 0,
          credentialType: String(body.credential_type),
        });
        return json(200, spendRequest(id, null));
      }
      const id = url.pathname.split("/")[2]!;
      if (method === "GET" && id) {
        if (state.nextRetrieve) {
          const next = state.nextRetrieve;
          state.nextRetrieve = null;
          return json(200, next);
        }
        const request = state.requests.get(id);
        if (!request) return json(404, { error: { message: "not found" } });
        if (request.status === "pending_approval" && request.reads++ > 0) {
          request.status = request.amount > 100_000 ? "denied" : "approved";
        }
        return json(200, spendRequest(id, url.searchParams.get("include")));
      }
    }
    return json(404, {});
  }) as typeof fetch;

  return { state, fetch: fetchImpl };
}

const suites: [string, () => PaymentWalletProvider][] = [
  ["emulator", () => new EmulatorPaymentWalletProvider()],
  ["Link over a fake Link API", () => new LinkWalletProvider({ fetch: fakeLink().fetch })],
];

/** Reads until the owner's decision lands; a provider may take one extra read. */
async function settle(
  provider: PaymentWalletProvider,
  credential: PaymentWalletCredential,
  id: string,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await provider.getPurchase(credential, id, ctx);
    if (snapshot.status !== "pending_approval") return snapshot;
  }
  throw new Error("Purchase never settled.");
}

const realm = "api.example.test";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function paymentRequired(amount = "500", id = "challenge-1") {
  return [
    `Payment id="tempo-1", realm="${realm}", method="tempo", intent="charge", request="${encode({ amount, currency: "0x01", recipient: "0x02" })}"`,
    Challenge.serialize({
      id,
      realm,
      method: "stripe",
      intent: "charge",
      request: { amount, currency: "usd", methodDetails: { networkId: "net_fake_seller" } },
    }),
  ].join(", ");
}

/** A paid API that takes a credential only for the challenge it issued last. */
function fakePaidApi() {
  let issued = 0;
  let amount = "500";
  const paid: string[] = [];
  return {
    paid,
    raise: (next: string) => {
      amount = next;
    },
    challenge: () => paymentRequired(amount, `challenge-${++issued}`),
    accept(authorization: string) {
      const credential = Credential.deserialize<{ spt: string }>(authorization);
      if (credential.challenge.id !== `challenge-${issued}`) return false;
      paid.push(credential.payload.spt);
      return true;
    },
  };
}

for (const [name, create] of suites) {
  describe(`payment wallet conformance: ${name}`, () => {
    it("connects, refreshes, and keeps working with the refreshed credential", async () => {
      const provider = create();
      const credential = await connect(provider);
      expect(credential.secret).toBeTruthy();
      expect(credential.refreshAt!.getTime()).toBeGreaterThan(Date.now());
      const refreshed = await provider.refresh(credential, ctx);
      expect(refreshed.secret).not.toBe(credential.secret);
      const created = await provider.createPurchase(refreshed, purchase(), ctx);
      expect(created.status).toBe("pending_approval");
    });

    it("waits for approval, then shows a card summary without the number", async () => {
      const provider = create();
      const credential = await connect(provider);
      const created = await provider.createPurchase(credential, purchase(), ctx);
      expect(created).toMatchObject({ status: "pending_approval" });
      expect(created.approvalUrl).toMatch(/^https:\/\//);
      expect(created.card).toBeUndefined();
      await expect(provider.revealCard(credential, created.id, ctx)).rejects.toBeInstanceOf(
        PaymentWalletRequestRejected,
      );

      const replay = await provider.createPurchase(credential, purchase(), ctx);
      expect(replay.id).toBe(created.id);

      const approved = await settle(provider, credential, created.id);
      expect(approved.status).toBe("approved");
      expect(approved.card).toMatchObject({ brand: "visa", last4: "4242", expMonth: 12 });
      expect(approved.card?.billingAddress).toMatchObject({ name: "Test User", country: "US" });
      expect(JSON.stringify(approved)).not.toContain("4242424242424242");
      expect(JSON.stringify(approved)).not.toContain('"123"');

      expect(await provider.revealCard(credential, created.id, ctx)).toEqual({
        number: "4242424242424242",
        cvc: "123",
      });
    });

    it("reports a denied purchase and refuses its card", async () => {
      const provider = create();
      const credential = await connect(provider);
      const created = await provider.createPurchase(
        credential,
        purchase({ amount: 500_000, idempotencyKey: "op-big" }),
        ctx,
      );
      const denied = await settle(provider, credential, created.id);
      expect(denied.status).toBe("denied");
      expect(denied.card).toBeUndefined();
      await expect(provider.revealCard(credential, created.id, ctx)).rejects.toBeInstanceOf(
        PaymentWalletRequestRejected,
      );
    });

    it("treats a revoked credential as disconnected", async () => {
      const provider = create();
      const credential = await connect(provider);
      const created = await provider.createPurchase(credential, purchase(), ctx);
      await provider.disconnect(credential, ctx);
      await expect(provider.getPurchase(credential, created.id, ctx)).rejects.toBeInstanceOf(
        PaymentWalletDisconnected,
      );
      await expect(provider.createPurchase(credential, purchase(), ctx)).rejects.toBeInstanceOf(
        PaymentWalletDisconnected,
      );
      await expect(provider.refresh(credential, ctx)).rejects.toBeInstanceOf(
        PaymentWalletDisconnected,
      );
    });

    it("hands over a pay token only once approved, and no card", async () => {
      const provider = create();
      const credential = await connect(provider);
      const created = await provider.createPurchase(
        credential,
        purchase({
          credential: { kind: "pay_token", merchantAccountId: "acct_fake123" },
          idempotencyKey: "op-pay-token",
        }),
        ctx,
      );
      expect(created.status).toBe("pending_approval");
      await expect(provider.revealPayToken(credential, created.id, ctx)).rejects.toBeInstanceOf(
        PaymentWalletRequestRejected,
      );
      const approved = await settle(provider, credential, created.id);
      expect(approved.status).toBe("approved");
      expect(approved.card).toBeUndefined();
      const token = await provider.revealPayToken(credential, created.id, ctx);
      expect(token).toMatch(/\S{8,}/);
      expect(JSON.stringify(approved)).not.toContain(token);
      await expect(provider.revealCard(credential, created.id, ctx)).rejects.toBeInstanceOf(
        PaymentWalletRequestRejected,
      );
    });

    it("pays the Stripe challenge of a 402 response after approval", async () => {
      const provider = create();
      const credential = await connect(provider);
      const api = fakePaidApi();
      const read = await provider.readHttpPaymentChallenge(api.challenge());
      expect(read).toMatchObject({ amount: 500, currency: "usd" });
      expect(
        await provider.readHttpPaymentChallenge(paymentRequired().split(", Payment ")[0]!),
      ).toBeNull();
      await expect(
        provider.createPurchase(
          credential,
          purchase({
            credential: { kind: "http_payment", challenge: read!.challenge },
            amount: 600,
            idempotencyKey: "op-http-wrong",
          }),
          ctx,
        ),
      ).rejects.toBeInstanceOf(PaymentWalletRequestRejected);
      const created = await provider.createPurchase(
        credential,
        purchase({
          credential: { kind: "http_payment", challenge: read!.challenge },
          amount: 500,
          idempotencyKey: "op-http",
        }),
        ctx,
      );
      await expect(
        provider.authorizeHttpPayment(
          credential,
          created.id,
          read!.challenge,
          api.challenge(),
          ctx,
        ),
      ).rejects.toBeInstanceOf(PaymentWalletRequestRejected);
      expect((await settle(provider, credential, created.id)).status).toBe("approved");

      const payment = await provider.authorizeHttpPayment(
        credential,
        created.id,
        read!.challenge,
        api.challenge(),
        ctx,
      );
      expect(Object.keys(payment.headers)).toEqual(["authorization"]);
      expect(api.accept(payment.headers.authorization!)).toBe(true);
      expect(api.paid).toEqual(payment.secrets);

      api.raise("900");
      await expect(
        provider.authorizeHttpPayment(
          credential,
          created.id,
          read!.challenge,
          api.challenge(),
          ctx,
        ),
      ).rejects.toBeInstanceOf(PaymentWalletRequestRejected);
    });

    it("honors abort", async () => {
      const provider = create();
      const credential = await connect(provider);
      await expect(
        provider.createPurchase(credential, purchase(), { ...ctx, signal: AbortSignal.abort() }),
      ).rejects.toThrow();
    });
  });
}

describe("Link wallet protocol", () => {
  it("signs in with the device flow and backs off on slow_down", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const start = await provider.beginConnect({ clientName: "Rakazo" }, ctx);
    expect(start).toMatchObject({
      verificationUrl: "https://app.link.com/device?code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
      intervalMs: 5000,
    });
    expect(start.state).not.toContain("fake-access");
    expect(await provider.pollConnect(start.state, ctx)).toEqual({ status: "pending" });
    link.state.tokenResponse = { status: 400, body: { error: "slow_down" } };
    expect(await provider.pollConnect(start.state, ctx)).toEqual({
      status: "pending",
      slowDown: true,
    });
    link.state.tokenResponse = { status: 400, body: { error: "expired_token" } };
    expect(await provider.pollConnect(start.state, ctx)).toEqual({ status: "expired" });
    link.state.tokenResponse = { status: 400, body: { error: "access_denied" } };
    expect(await provider.pollConnect(start.state, ctx)).toEqual({ status: "denied" });
    link.state.tokenResponse = null;
    const result = await provider.pollConnect(start.state, ctx);
    expect(result.status).toBe("connected");
    const credential = result.status === "connected" ? result.credential : null;
    const expectedRefreshAt = Date.now() + 3600_000 - 60_000;
    expect(Math.abs(credential!.refreshAt!.getTime() - expectedRefreshAt)).toBeLessThan(5000);
  });

  it("does not read an oversized sign-in response", async () => {
    const link = fakeLink();
    let cancel: unknown;
    const provider = new LinkWalletProvider({
      fetch: async (input, init) => {
        const response = await link.fetch(input, init);
        const oversized = new Response(response.body, {
          status: response.status,
          headers: { "content-length": String(1024 * 1024 * 1024) },
        });
        cancel = vi.spyOn(oversized.body!, "cancel");
        return oversized;
      },
    });
    await expect(provider.beginConnect({ clientName: "Rakazo" }, ctx)).rejects.toThrow(
      /^Link response is too large\.$/,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("revokes the refresh token on disconnect", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const credential = await connect(provider);
    const { refreshToken } = JSON.parse(credential.secret) as { refreshToken: string };
    await provider.disconnect(credential, ctx);
    expect(link.state.revoked).toEqual([refreshToken]);
  });

  it("always asks the owner and never pre-approves", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const credential = await connect(provider);
    await provider.createPurchase(credential, purchase(), ctx);
    expect(link.state.created[0]).toEqual({
      credential_type: "card",
      amount: 2500,
      currency: "usd",
      merchant_name: "Example Theater",
      merchant_url: "https://tickets.example.com/checkout",
      context: reason,
      request_approval: true,
      idempotency_key: "op-1",
    });
  });

  it("asks for pay tokens and HTTP payments without a merchant name or URL", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const credential = await connect(provider);
    await provider.createPurchase(
      credential,
      purchase({
        credential: { kind: "pay_token", merchantAccountId: "acct_fake123" },
        idempotencyKey: "op-pt",
      }),
      ctx,
    );
    const challenge = (await provider.readHttpPaymentChallenge(paymentRequired()))!.challenge;
    await provider.createPurchase(
      credential,
      purchase({
        credential: { kind: "http_payment", challenge },
        amount: 500,
        idempotencyKey: "op-spt",
      }),
      ctx,
    );
    expect(link.state.created).toEqual([
      {
        credential_type: "link_pay_token",
        merchant_account_id: "acct_fake123",
        amount: 2500,
        currency: "usd",
        context: reason,
        request_approval: true,
        idempotency_key: "op-pt",
      },
      {
        credential_type: "shared_payment_token",
        network_id: "net_fake_seller",
        amount: 500,
        currency: "usd",
        context: reason,
        request_approval: true,
        idempotency_key: "op-spt",
      },
    ]);
  });

  it("maps provider statuses", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const credential = await connect(provider);
    const base = { id: "lsrq_x", created_at: "t", updated_at: "t" };
    const nextAction = (resolution: string) => ({
      requires_action: {
        next_action: {
          type: "three_d_secure",
          resolution,
          display_message: "Verify",
          action_url: "https://app.link.com/action/x",
        },
      },
    });
    const cases: [Record<string, unknown>, string][] = [
      [{ status: "created" }, "pending_approval"],
      [
        { status: "requires_action", status_details: nextAction("auto_resume") },
        "pending_approval",
      ],
      [
        { status: "requires_action", status_details: nextAction("create_new_spend_request") },
        "needs_action",
      ],
      [{ status: "succeeded" }, "completed"],
      [{ status: "submitted" }, "completed"],
      [{ status: "expired" }, "expired"],
      [{ status: "canceled" }, "canceled"],
      [{ status: "failed" }, "failed"],
    ];
    for (const [fields, status] of cases) {
      link.state.nextRetrieve = { ...base, ...fields };
      expect((await provider.getPurchase(credential, "lsrq_x", ctx)).status).toBe(status);
    }
    link.state.nextRetrieve = {
      ...base,
      status: "requires_action",
      approval_url: "https://app.link.com/approve/x",
      status_details: nextAction("create_new_spend_request"),
    };
    expect((await provider.getPurchase(credential, "lsrq_x", ctx)).approvalUrl).toBe(
      "https://app.link.com/action/x",
    );
  });

  it("rejects with provider codes but never echoes response bodies", async () => {
    const link = fakeLink();
    const provider = new LinkWalletProvider({ fetch: link.fetch });
    const credential = await connect(provider);
    link.state.nextCreate = {
      status: 400,
      body: { error: { code: "amount_too_large", message: "fake-secret-body detail" } },
    };
    const error = await provider
      .createPurchase(credential, purchase({ idempotencyKey: "op-2" }), ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentWalletRequestRejected);
    expect((error as Error).message).toBe("Link declined the request (amount_too_large).");

    link.state.nextCreate = { status: 500, body: { error: { message: "fake-secret-body" } } };
    const serverError = await provider
      .createPurchase(credential, purchase({ idempotencyKey: "op-3" }), ctx)
      .catch((caught: unknown) => caught);
    expect((serverError as Error).message).not.toContain("fake-secret-body");
    expect((serverError as Error).cause).toBeUndefined();

    await expect(provider.getPurchase(credential, "lsrq_missing", ctx)).rejects.toBeInstanceOf(
      PaymentWalletRequestRejected,
    );
  });
});

/** In-process Stripe REST substitute covering exactly the endpoints the billing adapter uses. */
export class StripeEmulator {
  readonly secretKey = "sk_test_fake";
  readonly priceId = "price_fake";
  readonly requests: Array<{
    method: string;
    path: string;
    headers: Headers;
    form: Record<string, string>;
  }> = [];
  readonly customers = new Map<string, { id: string; email: string; deleted: boolean }>();
  readonly sessions: StripeCheckoutSession[] = [];
  readonly subscriptions: StripeSubscriptionRecord[] = [];
  /** Customer balance in cents; negative is credit owed to the customer, as in Stripe. */
  readonly balances = new Map<string, number>();
  readonly balanceTransactions: Array<{
    id: string;
    customer: string;
    amount: number;
    metadata: Record<string, string>;
  }> = [];
  /** Largest page the list endpoint returns; lower it to exercise pagination. */
  pageSize = 100;
  /** Upcoming responses fail with these Stripe errors, in order. */
  readonly failures: StripeFailure[] = [];
  /** A key's first executed outcome, a 500 included, replayed to every later use of the key. */
  private readonly idempotent = new Map<
    string,
    { fingerprint: string; status: number; body: string }
  >();
  private sequence = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.stripe.com") throw new Error("Unexpected emulator origin");
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${this.secretKey}`)
      return stripeError({ status: 401, message: "Invalid API Key provided" });
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const form = Object.fromEntries(new URLSearchParams(method === "GET" ? url.search : body));
    this.requests.push({ method, path: url.pathname, headers, form });
    const failure = this.failures.shift();
    // Rate limiting happens before the endpoint runs, so it saves no idempotent result.
    if (failure?.status === 429) return stripeError(failure);
    const key = headers.get("idempotency-key");
    const fingerprint = `${method} ${url.pathname} ${body}`;
    const saved = key ? this.idempotent.get(key) : undefined;
    if (saved) {
      if (saved.fingerprint !== fingerprint) {
        return stripeError({
          status: 400,
          type: "idempotency_error",
          message: "Keys for idempotent requests can only be used with the same parameters.",
        });
      }
      return new Response(saved.body, {
        status: saved.status,
        headers: { "content-type": "application/json", "idempotent-replayed": "true" },
      });
    }
    const response = failure ? stripeError(failure) : this.route(method, url.pathname, form);
    if (key && (response.ok || response.status >= 500)) {
      this.idempotent.set(key, {
        fingerprint,
        status: response.status,
        body: await response.clone().text(),
      });
    }
    return response;
  };

  /** The customer finishes their open checkout. An expired session cannot be paid. */
  completeCheckout(customerId: string, status?: string, cardFingerprint = "fp_fake_card") {
    const checkout = this.sessions.findLast(
      (session) => session.customer === customerId && session.status === "open",
    );
    if (!checkout) throw new Error(`No open checkout for ${customerId}`);
    checkout.status = "complete";
    const n = ++this.sequence;
    const nowSeconds = Math.floor(this.now() / 1000);
    const trialDays = checkout.form["subscription_data[trial_period_days]"];
    const trialEnd = trialDays ? nowSeconds + Number(trialDays) * 86_400 : null;
    this.subscriptions.push({
      id: `sub_fake_${n}`,
      object: "subscription",
      customer: customerId,
      status: status ?? (trialEnd ? "trialing" : "active"),
      created: nowSeconds + n,
      trial_end: trialEnd,
      cancel_at_period_end: false,
      cancel_at: null,
      ended_at: null,
      default_payment_method: `pm_fake_${n}`,
      cardFingerprint,
      items: {
        object: "list",
        data: [
          {
            id: `si_fake_${n}`,
            object: "subscription_item",
            price: { id: checkout.form["line_items[0][price]"]!, object: "price" },
            quantity: Number(checkout.form["line_items[0][quantity]"]),
            current_period_start: nowSeconds,
            current_period_end: trialEnd ?? nowSeconds + 30 * 86_400,
          },
        ],
      },
    });
    return `sub_fake_${n}`;
  }

  /** Deleting cancels the customer's subscriptions and refuses later requests that name it. */
  deleteCustomer(customerId: string) {
    const customer = this.customers.get(customerId);
    if (!customer || customer.deleted) throw new Error(`No customer ${customerId}`);
    customer.deleted = true;
    for (const subscription of this.forCustomer(customerId)) {
      if (isTerminal(subscription.status)) continue;
      subscription.status = "canceled";
      subscription.ended_at = Math.floor(this.now() / 1000);
    }
  }

  /** Moves the customer's newest subscription to a raw Stripe status. */
  setStatus(customerId: string, status: string) {
    const newest = this.forCustomer(customerId)[0];
    if (!newest) throw new Error(`No subscription for ${customerId}`);
    newest.status = status;
  }

  private route(method: string, path: string, form: Record<string, string>): Response {
    if (method === "GET" && path === `/v1/prices/${this.priceId}`)
      return Response.json({
        id: this.priceId,
        object: "price",
        unit_amount: 1000,
        currency: "usd",
        recurring: { interval: "month", interval_count: 1 },
      });
    if (method === "POST" && path === "/v1/customers") {
      const id = `cus_fake_${this.customers.size + 1}`;
      this.customers.set(id, { id, email: form.email ?? "", deleted: false });
      return Response.json({ id, object: "customer", email: form.email, metadata: {} });
    }
    const customer = form.customer ?? "";
    const namesCustomer =
      path === "/v1/checkout/sessions" ||
      path === "/v1/billing_portal/sessions" ||
      path === "/v1/subscriptions";
    if (namesCustomer && this.customers.get(customer)?.deleted !== false) {
      return stripeError({
        status: 400,
        code: "resource_missing",
        param: "customer",
        message: `No such customer: '${customer}'`,
      });
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const id = `cs_fake_${++this.sequence}`;
      this.sessions.push({ id, customer, status: "open", form });
      return Response.json({
        id,
        object: "checkout.session",
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
      });
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const matching = this.sessions.filter(
        (session) =>
          session.customer === customer &&
          (form.status === undefined || session.status === form.status),
      );
      const start = form.starting_after
        ? matching.findIndex((session) => session.id === form.starting_after) + 1
        : 0;
      const limit = Math.min(Number(form.limit ?? 10), this.pageSize);
      const data = matching.slice(start, start + limit).map((session) => ({
        id: session.id,
        object: "checkout.session",
        status: session.status,
      }));
      return Response.json({ object: "list", has_more: start + limit < matching.length, data });
    }
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
    if (method === "POST" && expire) {
      const found = this.sessions.find((session) => session.id === decodeURIComponent(expire[1]!));
      if (!found) return stripeError({ status: 404, message: "No such checkout session" });
      if (found.status !== "open") {
        return stripeError({
          status: 400,
          message: `This Checkout Session has a status of \`${found.status}\` and cannot be expired.`,
        });
      }
      found.status = "expired";
      return Response.json({ id: found.id, object: "checkout.session", status: "expired" });
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions")
      return Response.json({
        id: "bps_fake",
        object: "billing_portal.session",
        url: `https://billing.stripe.com/p/session/${customer}`,
      });
    if (method === "GET" && path === "/v1/subscriptions") {
      const matching = this.forCustomer(customer).filter(
        (s) => form.status === "all" || s.status !== "canceled",
      );
      const start = form.starting_after
        ? matching.findIndex((s) => s.id === form.starting_after) + 1
        : 0;
      const limit = Math.min(Number(form.limit ?? 10), this.pageSize);
      const expandCard = Object.entries(form).some(
        ([key, value]) => key.startsWith("expand[") && value === "data.default_payment_method",
      );
      const data = matching
        .slice(start, start + limit)
        .map(({ cardFingerprint, ...subscription }) =>
          expandCard && subscription.default_payment_method
            ? {
                ...subscription,
                default_payment_method: {
                  id: subscription.default_payment_method,
                  object: "payment_method",
                  card: { fingerprint: cardFingerprint },
                },
              }
            : subscription,
        );
      return Response.json({ object: "list", has_more: start + limit < matching.length, data });
    }
    const balance = /^\/v1\/customers\/([^/]+)\/balance_transactions$/.exec(path);
    if (method === "GET" && balance) {
      const id = decodeURIComponent(balance[1]!);
      const data = this.balanceTransactions.filter((entry) => entry.customer === id);
      return Response.json({ object: "list", has_more: false, data });
    }
    if (method === "POST" && balance) {
      const id = decodeURIComponent(balance[1]!);
      if (this.customers.get(id)?.deleted !== false)
        return stripeError({
          status: 404,
          message: "No such customer",
          code: "resource_missing",
          param: "customer",
        });
      const next = (this.balances.get(id) ?? 0) + Number(form.amount);
      this.balances.set(id, next);
      const metadata = Object.fromEntries(
        Object.entries(form).flatMap(([key, value]) => {
          const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
          return name ? [[name, value]] : [];
        }),
      );
      const transaction = {
        id: `cbtxn_fake_${++this.sequence}`,
        customer: id,
        amount: Number(form.amount),
        metadata,
      };
      this.balanceTransactions.push(transaction);
      return Response.json({
        ...transaction,
        object: "customer_balance_transaction",
        amount: Number(form.amount),
        currency: form.currency,
        ending_balance: next,
      });
    }
    const item = /^\/v1\/subscription_items\/([^/]+)$/.exec(path);
    if (method === "POST" && item) {
      const id = decodeURIComponent(item[1]!);
      const parent = this.subscriptions.find((s) => s.items.data.some((i) => i.id === id));
      const found = parent?.items.data.find((i) => i.id === id);
      if (!parent || !found)
        return stripeError({ status: 404, message: "No such subscription item" });
      if (isTerminal(parent.status)) return canceledSubscriptionError();
      found.quantity = Number(form.quantity);
      return Response.json(found);
    }
    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (method === "POST" && subscription && form.trial_end === "now") {
      const found = this.subscriptions.find((s) => s.id === decodeURIComponent(subscription[1]!));
      if (!found) return stripeError({ status: 404, message: "No such subscription" });
      if (isTerminal(found.status)) return canceledSubscriptionError();
      const nowSeconds = Math.floor(this.now() / 1000);
      found.status = "active";
      found.trial_end = nowSeconds;
      for (const entry of found.items.data) {
        entry.current_period_start = nowSeconds;
        entry.current_period_end = nowSeconds + 30 * 86_400;
      }
      return Response.json(found);
    }
    if (method === "DELETE" && subscription) {
      const found = this.subscriptions.find((s) => s.id === decodeURIComponent(subscription[1]!));
      if (!found) return stripeError({ status: 404, message: "No such subscription" });
      if (isTerminal(found.status)) return canceledSubscriptionError();
      found.status = "canceled";
      found.ended_at = Math.floor(this.now() / 1000);
      return Response.json(found);
    }
    return stripeError({ status: 404, message: `Unrecognized request URL (${method}: ${path})` });
  }

  private forCustomer(customerId: string) {
    return this.subscriptions
      .filter((s) => s.customer === customerId)
      .sort((a, b) => b.created - a.created);
  }
}

export interface StripeCheckoutSession {
  id: string;
  customer: string;
  status: "open" | "expired" | "complete";
  form: Record<string, string>;
}

export interface StripeSubscriptionRecord {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  created: number;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  ended_at: number | null;
  cancellation_details?: { feedback: string | null; comment: string | null };
  default_payment_method?: string | null;
  /** Emulator-only: the card's fingerprint, returned when the payment method is expanded. */
  cardFingerprint?: string;
  items: {
    object: "list";
    data: Array<{
      id: string;
      object: "subscription_item";
      price: { id: string; object: "price" };
      quantity: number;
      current_period_start?: number;
      current_period_end: number;
    }>;
  };
}

export interface StripeFailure {
  status: number;
  message: string;
  type?: string;
  code?: string;
  param?: string;
  headers?: Record<string, string>;
}

function isTerminal(status: string) {
  return status === "canceled" || status === "incomplete_expired";
}

function canceledSubscriptionError() {
  return stripeError({
    status: 400,
    message: "A canceled subscription can only update its cancellation_details.",
  });
}

function stripeError({ status, message, type, code, param, headers }: StripeFailure) {
  const error = {
    type: type ?? (status >= 500 ? "api_error" : "invalid_request_error"),
    message,
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  };
  return Response.json({ error }, { status, headers });
}

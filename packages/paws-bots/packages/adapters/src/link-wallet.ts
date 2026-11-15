import type {
  AdapterContext,
  AdapterDescriptor,
  HttpPaymentAuthorization,
  HttpPaymentChallenge,
  PaymentBillingAddress,
  PaymentCardSecret,
  PaymentWalletCapabilities,
  PaymentWalletConnectResult,
  PaymentWalletConnectStart,
  PaymentWalletCredential,
  PaymentWalletProvider,
  PurchaseCredentialKind,
  PurchaseRequest,
  PurchaseSnapshot,
  PurchaseStatus,
} from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, PaymentWalletRequestRejected } from "@rakazo/adapter-kit";
import { abortableDelay, readJsonObjectWithin } from "@rakazo/core";
import Link, { getDuplicateSpendRequest, LinkApiError } from "@stripe/link-sdk";
import {
  readStripeChargeChallenge,
  stripeChargeAuthorization,
  stripeChargeTerms,
} from "./mpp-stripe.js";

/** Link's public device-flow client, the one `@stripe/link-cli` signs in with. */
export const LINK_PUBLIC_CLIENT_ID = "lwlpk_U7Qy7ThG69STZk";
const SCOPE = "userinfo:read payment_methods.agentic";
const REFRESH_MARGIN_MS = 60_000;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

export interface LinkWalletOptions {
  clientId?: string;
  fetch?: typeof fetch;
  authBaseUrl?: string;
  apiBaseUrl?: string;
}

interface LinkSecret {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

/**
 * The fields read from a Link spend request. Declared here because the SDK's bundled
 * declarations use extensionless relative paths that NodeNext resolution cannot follow.
 */
interface SpendRequest {
  id: string;
  status: string;
  approval_url?: string;
  card_last4?: string;
  card?: {
    brand: string;
    number: string;
    cvc?: string;
    exp_month: number;
    exp_year: number;
    billing_address?: {
      name: string;
      line1: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country: string;
    };
  };
  status_details?: {
    requires_action?: { next_action: { resolution: string; action_url: string | null } };
  } | null;
  credential_type?: string;
  link_pay_token?: string;
  shared_payment_token?: { id: string } | null;
}

const CREDENTIAL_TYPES = {
  card: "card",
  pay_token: "link_pay_token",
  http_payment: "shared_payment_token",
} as const satisfies Record<PurchaseCredentialKind, string>;

function matchesType(request: SpendRequest, kind: PurchaseCredentialKind) {
  return (
    request.credential_type === undefined || request.credential_type === CREDENTIAL_TYPES[kind]
  );
}

/** Link can take a moment after approval to issue the token, as `link-cli mpp pay` allows for. */
const SHARED_TOKEN_RETRY_MS = [0, 1000, 1000, 2000, 2000];

interface SpendRequests {
  create(params: Record<string, unknown>): Promise<SpendRequest>;
  retrieve(id: string, options: { include: string[] }): Promise<SpendRequest | null>;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

export class LinkWalletProvider implements PaymentWalletProvider {
  readonly displayName = "Link";
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string | undefined;

  constructor(options: LinkWalletOptions = {}) {
    this.clientId = options.clientId || LINK_PUBLIC_CLIENT_ID;
    this.fetchImpl = options.fetch ?? fetch;
    this.authBaseUrl = (options.authBaseUrl ?? "https://login.link.com").replace(/\/$/, "");
    this.apiBaseUrl = options.apiBaseUrl;
  }

  describe(): AdapterDescriptor<PaymentWalletCapabilities> {
    return {
      id: "link",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, credentials: ["card", "pay_token", "http_payment"] },
    };
  }

  async beginConnect(
    request: { clientName: string },
    context: AdapterContext,
  ): Promise<PaymentWalletConnectStart> {
    const { status, body } = await this.authPost(
      "/device/code",
      {
        client_id: this.clientId,
        scope: SCOPE,
        connection_label: request.clientName,
        client_hint: request.clientName,
      },
      context,
    );
    const deviceCode = text(body.device_code);
    const userCode = text(body.user_code);
    const verificationUrl = text(body.verification_uri_complete) ?? text(body.verification_uri);
    // Clients open this page, so only an HTTPS link is passed on.
    if (
      status !== 200 ||
      !deviceCode ||
      !userCode ||
      !verificationUrl ||
      !URL.canParse(verificationUrl) ||
      new URL(verificationUrl).protocol !== "https:"
    ) {
      throw new Error(`Link sign-in could not start (${status}).`);
    }
    return {
      state: JSON.stringify({ deviceCode }),
      verificationUrl,
      userCode,
      expiresAt: new Date(Date.now() + seconds(body.expires_in, 900) * 1000),
      intervalMs: seconds(body.interval, 5) * 1000,
    };
  }

  async pollConnect(state: string, context: AdapterContext): Promise<PaymentWalletConnectResult> {
    const { deviceCode } = JSON.parse(state) as { deviceCode: string };
    const { status, body } = await this.authPost(
      "/device/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.clientId,
      },
      context,
    );
    if (status === 200) return { status: "connected", credential: credentialFrom(body) };
    switch (body.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "pending", slowDown: true };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
      case "authorization_failed":
        return { status: "denied" };
      default:
        throw new Error(`Link sign-in failed (${status}).`);
    }
  }

  async refresh(
    credential: PaymentWalletCredential,
    context: AdapterContext,
  ): Promise<PaymentWalletCredential> {
    const current = readSecret(credential);
    const { status, body } = await this.authPost(
      "/device/token",
      {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: this.clientId,
      },
      context,
    );
    if (status === 200) return credentialFrom(body, current.refreshToken);
    if (status === 400 || status === 401) throw new PaymentWalletDisconnected();
    throw new Error(`Link refresh failed (${status}).`);
  }

  async disconnect(credential: PaymentWalletCredential, context: AdapterContext): Promise<void> {
    const { refreshToken } = readSecret(credential);
    const { status } = await this.authPost(
      "/device/revoke",
      { client_id: this.clientId, token: refreshToken },
      context,
    );
    if (status < 200 || status >= 300) throw new Error(`Link sign-out failed (${status}).`);
  }

  async createPurchase(
    credential: PaymentWalletCredential,
    request: PurchaseRequest,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot> {
    const target = request.credential;
    // Link rejects a merchant name or URL on token requests: the account or network names the seller.
    const merchant =
      target.kind === "card"
        ? { merchant_name: target.merchantName, merchant_url: target.merchantUrl }
        : target.kind === "pay_token"
          ? { merchant_account_id: target.merchantAccountId }
          : { network_id: await this.chargeNetwork(target.challenge, request) };
    const link = this.client(credential, context);
    try {
      const created = await link.spendRequests.create({
        credential_type: CREDENTIAL_TYPES[target.kind],
        ...merchant,
        amount: request.amount,
        currency: request.currency,
        context: request.reason,
        request_approval: true,
        idempotency_key: request.idempotencyKey,
      });
      return snapshot(created);
    } catch (error) {
      const duplicate = getDuplicateSpendRequest(error) as SpendRequest | null;
      if (duplicate) return snapshot(duplicate);
      throw linkError(error, context);
    }
  }

  async getPurchase(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot> {
    return snapshot(await this.retrieve(credential, id, context));
  }

  async revealCard(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PaymentCardSecret> {
    const request = await this.retrieve(credential, id, context);
    if (request.status !== "approved" || !request.card?.number) {
      throw new PaymentWalletRequestRejected("The purchase is not approved.");
    }
    return request.card.cvc
      ? { number: request.card.number, cvc: request.card.cvc }
      : { number: request.card.number };
  }

  async revealPayToken(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<string> {
    const request = await this.retrieve(credential, id, context, "link_pay_token");
    if (
      request.status !== "approved" ||
      !matchesType(request, "pay_token") ||
      !request.link_pay_token
    ) {
      throw new PaymentWalletRequestRejected("The purchase is not approved.");
    }
    return request.link_pay_token;
  }

  async readHttpPaymentChallenge(wwwAuthenticate: string): Promise<HttpPaymentChallenge | null> {
    const charge = await readStripeChargeChallenge(wwwAuthenticate);
    return (
      charge && { challenge: charge.challenge, amount: charge.amount, currency: charge.currency }
    );
  }

  async authorizeHttpPayment(
    credential: PaymentWalletCredential,
    id: string,
    approved: string,
    wwwAuthenticate: string,
    context: AdapterContext,
  ): Promise<HttpPaymentAuthorization> {
    let request: SpendRequest | undefined;
    for (const delayMs of SHARED_TOKEN_RETRY_MS) {
      if (delayMs) await abortableDelay(delayMs, context.signal);
      request = await this.retrieve(credential, id, context, "shared_payment_token");
      if (request.status !== "approved" || !matchesType(request, "http_payment"))
        throw new PaymentWalletRequestRejected("The purchase is not approved.");
      if (request.shared_payment_token?.id) break;
    }
    const token = request?.shared_payment_token?.id;
    if (!token) throw new Error("Link did not issue the payment token.");
    return {
      headers: { authorization: await stripeChargeAuthorization(approved, wwwAuthenticate, token) },
      secrets: [token],
    };
  }

  private async chargeNetwork(challenge: string, request: PurchaseRequest) {
    const terms = await stripeChargeTerms(challenge);
    if (terms.amount !== request.amount || terms.currency !== request.currency) {
      throw new PaymentWalletRequestRejected("The amount must match the payment request.");
    }
    return terms.networkId;
  }

  private async retrieve(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
    include: "card" | "link_pay_token" | "shared_payment_token" = "card",
  ): Promise<SpendRequest> {
    // The SDK interpolates the id into the request path.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new PaymentWalletRequestRejected("The purchase was not found.");
    }
    const link = this.client(credential, context);
    let request: SpendRequest | null;
    try {
      request = await link.spendRequests.retrieve(id, { include: [include] });
    } catch (error) {
      throw linkError(error, context);
    }
    if (!request) throw new PaymentWalletRequestRejected("The purchase was not found.");
    return request;
  }

  private client(
    credential: PaymentWalletCredential,
    context: AdapterContext,
  ): { spendRequests: SpendRequests } {
    context.signal.throwIfAborted();
    const fetchImpl = this.fetchImpl;
    return new Link({
      accessToken: readSecret(credential).accessToken,
      fetch: ((input, init) =>
        fetchImpl(input, { ...init, signal: context.signal })) as typeof fetch,
      ...(this.apiBaseUrl ? { apiBaseUrl: this.apiBaseUrl } : {}),
    });
  }

  private async authPost(
    path: string,
    form: Record<string, string>,
    context: AdapterContext,
  ): Promise<{ status: number; body: TokenResponse & Record<string, unknown> }> {
    const response = await this.fetchImpl(`${this.authBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: context.signal,
    });
    // Non-JSON bodies are treated as empty; they are never echoed.
    const body = await readJsonObjectWithin<TokenResponse & Record<string, unknown>>(response, {
      maxBytes: MAX_AUTH_RESPONSE_BYTES,
      tooLargeMessage: "Link response is too large.",
      signal: context.signal,
    });
    return { status: response.status, body };
  }
}

function credentialFrom(body: TokenResponse, previousRefreshToken?: string) {
  const accessToken = text(body.access_token);
  const refreshToken = text(body.refresh_token) ?? previousRefreshToken;
  if (!accessToken || !refreshToken) throw new Error("Link returned an incomplete credential.");
  const accessExpiresAt = Date.now() + seconds(body.expires_in, 3600) * 1000;
  const secret: LinkSecret = { accessToken, refreshToken, accessExpiresAt };
  return {
    secret: JSON.stringify(secret),
    refreshAt: new Date(accessExpiresAt - REFRESH_MARGIN_MS),
  } satisfies PaymentWalletCredential;
}

function readSecret(credential: PaymentWalletCredential): LinkSecret {
  try {
    const parsed = JSON.parse(credential.secret) as Partial<LinkSecret>;
    if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string") {
      return parsed as LinkSecret;
    }
  } catch {
    // Fall through: an unreadable credential is a disconnected one.
  }
  throw new PaymentWalletDisconnected();
}

function snapshot(request: SpendRequest): PurchaseSnapshot {
  const status = mapStatus(request);
  const nextAction = request.status_details?.requires_action?.next_action;
  const approvalUrl =
    (status === "needs_action" ? nextAction?.action_url : undefined) ?? request.approval_url;
  const result: PurchaseSnapshot = { id: request.id, status };
  if (approvalUrl) result.approvalUrl = approvalUrl;
  const card = request.card;
  if (status === "approved" && card) {
    result.card = {
      brand: card.brand,
      last4: request.card_last4 ?? card.number.slice(-4),
      expMonth: card.exp_month,
      expYear: card.exp_year,
      ...(card.billing_address ? { billingAddress: billingAddress(card.billing_address) } : {}),
    };
  }
  return result;
}

function mapStatus(request: SpendRequest): PurchaseStatus {
  switch (request.status) {
    case "created":
    case "pending_approval":
      return "pending_approval";
    case "requires_action":
      return request.status_details?.requires_action?.next_action.resolution === "auto_resume"
        ? "pending_approval"
        : "needs_action";
    case "submitted":
    case "succeeded":
      return "completed";
    case "approved":
    case "denied":
    case "expired":
    case "canceled":
    case "failed":
      return request.status;
    default:
      // Unknown future statuses ask the owner to look rather than silently waiting.
      return "needs_action";
  }
}

function billingAddress(
  address: NonNullable<NonNullable<SpendRequest["card"]>["billing_address"]>,
): PaymentBillingAddress {
  return {
    name: address.name,
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.postal_code ? { postalCode: address.postal_code } : {}),
    country: address.country,
  };
}

/** Never carries the SDK's message, which embeds the raw response body. */
function linkError(error: unknown, context: AdapterContext): unknown {
  if (context.signal.aborted) return context.signal.reason;
  if (error instanceof PaymentWalletDisconnected || error instanceof PaymentWalletRequestRejected) {
    return error;
  }
  if (error instanceof LinkApiError) {
    const { status, details } = error as { status: number; details: unknown };
    if (status === 401) return new PaymentWalletDisconnected();
    if (status >= 400 && status < 500) {
      const code = providerCode(details);
      return new PaymentWalletRequestRejected(
        code ? `Link declined the request (${code}).` : "Link declined the request.",
      );
    }
    return new Error(`Link request failed (${status}).`);
  }
  return new Error("Link request failed.");
}

function providerCode(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { error?: unknown }).error;
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? ((value as { code?: unknown }).code ?? (value as { type?: unknown }).type)
        : undefined;
  return typeof candidate === "string" && /^[a-z0-9_]{1,64}$/.test(candidate)
    ? candidate
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

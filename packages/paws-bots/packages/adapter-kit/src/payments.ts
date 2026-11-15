import type { AdapterContext, AdapterDescriptor } from "./types.js";

/**
 * A provider-owned wallet credential. Product code stores `secret` encrypted and never
 * reads it; the provider asks for `refresh` before `refreshAt`.
 */
export interface PaymentWalletCredential {
  secret: string;
  refreshAt: Date | null;
}

/** A sign-in the user finishes on the provider's own page or app. */
export interface PaymentWalletConnectStart {
  /** Opaque, provider-owned; product code stores it encrypted for `pollConnect`. */
  state: string;
  verificationUrl: string;
  /** The phrase the user checks against the provider's page. */
  userCode: string;
  expiresAt: Date;
  intervalMs: number;
}

export type PaymentWalletConnectResult =
  /** `slowDown`: the provider asked for a longer polling interval. */
  | { status: "pending"; slowDown?: boolean }
  | { status: "connected"; credential: PaymentWalletCredential }
  | { status: "denied" | "expired" };

/**
 * Vendor-neutral purchase status. `pending_approval` waits on the wallet owner;
 * `needs_action` waits on something only the owner can resolve on the provider's side.
 */
export type PurchaseStatus =
  | "pending_approval"
  | "needs_action"
  | "approved"
  | "denied"
  | "expired"
  | "canceled"
  | "completed"
  | "failed";

export type PurchaseCredentialKind = "card" | "pay_token" | "http_payment";

export interface HttpPaymentChallenge {
  /** Opaque, provider-owned; pinned at approval and compared again before paying. */
  challenge: string;
  /** In the currency's minor unit. */
  amount: number;
  /** Lowercase ISO 4217 code. */
  currency: string;
}

export type PurchaseCredential =
  | { kind: "card"; merchantName: string; merchantUrl: string }
  | { kind: "pay_token"; merchantAccountId: string }
  /** `challenge` from `readHttpPaymentChallenge`. */
  | { kind: "http_payment"; challenge: string };

export interface PurchaseRequest {
  credential: PurchaseCredential;
  /** In the currency's minor unit, such as cents for USD. */
  amount: number;
  /** Lowercase ISO 4217 code. */
  currency: string;
  /** What is being bought and why, shown to the wallet owner when they approve. */
  reason: string;
  /** Stable across retries of the same intent. */
  idempotencyKey: string;
}

export interface PaymentBillingAddress {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
}

/** Card details that are safe to show the bot. The number and security code are not. */
export interface PurchaseCardSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  billingAddress?: PaymentBillingAddress;
}

export interface PurchaseSnapshot {
  id: string;
  status: PurchaseStatus;
  /** Where the wallet owner approves or resolves the purchase. */
  approvalUrl?: string;
  /** Present once approved. */
  card?: PurchaseCardSummary;
}

/** Single-use card secrets. Only the page fill path may hold them. */
export interface PaymentCardSecret {
  number: string;
  cvc?: string;
}

export interface HttpPaymentAuthorization {
  headers: Record<string, string>;
  secrets: string[];
}

export interface PaymentWalletCapabilities {
  /** Runs without the network; only the emulator. */
  offline: boolean;
  credentials: readonly PurchaseCredentialKind[];
}

/**
 * A wallet an agent spends from, where the wallet owner approves every purchase on the
 * provider's side. Core runs with none configured; purchase tools are offered only to a
 * user who connected one.
 */
export interface PaymentWalletProvider {
  describe(): AdapterDescriptor<PaymentWalletCapabilities>;
  /** Product name shown on the connect button. */
  readonly displayName: string;
  beginConnect(
    request: { clientName: string },
    context: AdapterContext,
  ): Promise<PaymentWalletConnectStart>;
  pollConnect(state: string, context: AdapterContext): Promise<PaymentWalletConnectResult>;
  refresh(
    credential: PaymentWalletCredential,
    context: AdapterContext,
  ): Promise<PaymentWalletCredential>;
  /** Revoke the credential with the provider. */
  disconnect(credential: PaymentWalletCredential, context: AdapterContext): Promise<void>;
  /** Create a purchase and ask the wallet owner to approve it. Never pre-approved. */
  createPurchase(
    credential: PaymentWalletCredential,
    request: PurchaseRequest,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot>;
  getPurchase(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PurchaseSnapshot>;
  /** Fails unless the purchase is approved. */
  revealCard(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<PaymentCardSecret>;
  /** Fails unless the purchase is an approved pay token purchase. */
  revealPayToken(
    credential: PaymentWalletCredential,
    id: string,
    context: AdapterContext,
  ): Promise<string>;
  /** The payment a 402 response's `WWW-Authenticate` asks for, or null if this wallet can't make it. */
  readHttpPaymentChallenge(wwwAuthenticate: string): Promise<HttpPaymentChallenge | null>;
  /**
   * Pay the challenge a retried request was answered with. Fails unless the purchase is approved
   * and that challenge asks for the same payment as the approved one.
   */
  authorizeHttpPayment(
    credential: PaymentWalletCredential,
    id: string,
    approved: string,
    wwwAuthenticate: string,
    context: AdapterContext,
  ): Promise<HttpPaymentAuthorization>;
}

/** The provider no longer accepts the credential; the user has to connect again. */
export class PaymentWalletDisconnected extends Error {
  constructor() {
    super("The wallet connection was revoked or expired. Connect it again in Settings.");
    this.name = "PaymentWalletDisconnected";
  }
}

/** The provider turned the request down; `message` is safe to show the bot. */
export class PaymentWalletRequestRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentWalletRequestRejected";
  }
}

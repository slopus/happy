import type {
  AdapterContext,
  JobPublisher,
  PaymentWalletCredential,
  PaymentWalletProvider,
  PurchaseCardSummary,
  PurchaseCredential,
  PurchaseCredentialKind,
  PurchaseSnapshot,
  PurchaseStatus,
} from "@rakazo/adapter-kit";
import {
  PaymentWalletDisconnected,
  PaymentWalletRequestRejected,
  purchasePollJob,
} from "@rakazo/adapter-kit";
import type { PurchaseCardField } from "@rakazo/contracts";
import { PurchaseIdInput, PurchaseRequestInput } from "@rakazo/contracts";
import type { Purchase } from "@rakazo/db";
import { recordPayment, releasePayment } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cardRedactionForms } from "./bot-secrets.js";
import type { PaymentWalletDeps } from "./payment-wallets.js";
import { withPaymentWalletCredential } from "./payment-wallets.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";
import { releaseUnpaidPurchase, spendingRefusalError } from "./spending-gate.js";
import type { SafeWebFetchOptions } from "./web-ssrf.js";

export type PurchaseDeps = Omit<PaymentWalletDeps, "paymentWallet"> & {
  jobs: JobPublisher;
  paymentWallet?: PaymentWalletProvider | null;
  paidRequestFetch?: Pick<SafeWebFetchOptions, "fetch" | "resolveHostname">;
};

/** Statuses that still wait on the wallet owner, so the worker keeps polling. */
export const PENDING_PURCHASE_STATUSES: ReadonlySet<string> = new Set<PurchaseStatus>([
  "pending_approval",
  "needs_action",
]);
export const PURCHASE_POLL_MS = 5_000;

export const NOT_CONFIGURED = { error: "No wallet is available." };
const DISCONNECTED = {
  error: "The user's wallet is not connected. Ask them to connect it in Settings, then try again.",
};
const NOT_APPROVED = { error: "The purchase is not approved. Check purchase_status." };

const NEXT: Record<string, string> = {
  pending_approval:
    "Tell the user to approve it in their wallet, then end your turn. You are woken when they decide.",
  needs_action:
    "The user must finish a step in their wallet at approvalUrl. You are woken when it changes.",
  denied: "The user declined. Do not retry unless they ask.",
  expired: "The approval request expired. Ask the user before requesting again.",
  canceled: "The purchase was canceled.",
  failed: "The purchase failed.",
  completed: "The purchase is complete.",
};

const NEXT_APPROVED: Record<PurchaseCredentialKind, string> = {
  card: "Type the card on merchantUrl with browser_act fill_card for each card field the checkout shows (number, expiry, cvc, postal_code), passing this purchase id. Type the cardholder name and address yourself.",
  pay_token:
    "On merchantUrl, use browser_act fill_pay_token with this purchase id, then submit the checkout.",
  http_payment: "Call paid_request with this purchase id to send the request with the payment.",
};

export function purchaseView(purchase: Purchase, card?: PurchaseCardSummary) {
  const status = purchase.status;
  const kind = credentialKind(purchase);
  return {
    id: purchase.id,
    status,
    merchantName: purchase.merchantName,
    merchantUrl: purchase.merchantUrl,
    amount: purchase.amount,
    currency: purchase.currency,
    ...(purchase.approvalUrl && PENDING_PURCHASE_STATUSES.has(status)
      ? { approvalUrl: purchase.approvalUrl }
      : {}),
    // Only the safe summary: the number and security code never reach the model.
    ...(card && status === "approved"
      ? {
          card: {
            brand: card.brand,
            last4: card.last4,
            expMonth: card.expMonth,
            expYear: card.expYear,
            ...(card.billingAddress ? { billingAddress: card.billingAddress } : {}),
          },
        }
      : {}),
    next:
      status !== "approved"
        ? NEXT[status]
        : kind === "card" && !card
          ? "Call purchase_status for the card details."
          : NEXT_APPROVED[kind],
  };
}

function credentialKind(purchase: Purchase): PurchaseCredentialKind {
  return purchase.credentialType === "pay_token" || purchase.credentialType === "http_payment"
    ? purchase.credentialType
    : "card";
}

export function providerError(error: unknown) {
  if (error instanceof PaymentWalletDisconnected) return DISCONNECTED;
  if (error instanceof PaymentWalletRequestRejected) return { error: error.message };
  throw error;
}

type WalletStoreDeps = Pick<PurchaseDeps, "prisma" | "secretStore">;

function walletDeps(deps: WalletStoreDeps, provider: PaymentWalletProvider): PaymentWalletDeps {
  return { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet: provider };
}

export function withPurchaseWallet<T>(
  deps: WalletStoreDeps,
  provider: PaymentWalletProvider,
  owner: { userId: string; spaceId: string },
  fn: (credential: PaymentWalletCredential) => Promise<T>,
): Promise<T> {
  return withPaymentWalletCredential(
    walletDeps(deps, provider),
    { userId: owner.userId, spaceId: owner.spaceId },
    fn,
  );
}

/** Load a purchase's live status from the wallet, failing like the provider does. */
export async function fetchPurchase(
  deps: WalletStoreDeps,
  provider: PaymentWalletProvider,
  purchase: Purchase,
  context: AdapterContext,
): Promise<PurchaseSnapshot> {
  return withPurchaseWallet(deps, provider, purchase, (credential) =>
    provider.getPurchase(credential, purchase.remoteId, context),
  );
}

export function walletSupports(provider: PaymentWalletProvider, kind: PurchaseCredentialKind) {
  return provider.describe().capabilities.credentials.includes(kind);
}

/** request_purchase and purchase_status. Results never carry the card number or security code. */
export async function executePurchaseTool(
  deps: PurchaseDeps,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  name: string,
  args: Record<string, unknown>,
) {
  const provider = deps.paymentWallet;
  if (!provider) return NOT_CONFIGURED;
  if (name === "request_purchase") return requestPurchase(deps, provider, context, run, args);
  const parsed = PurchaseIdInput.safeParse(args);
  if (!parsed.success) return { error: "A purchase id is required." };
  const purchase = await findBotPurchase(deps, context, parsed.data.id);
  if (!purchase) return { error: "Unknown purchase." };
  if (!PENDING_PURCHASE_STATUSES.has(purchase.status) && purchase.status !== "approved")
    return purchaseView(purchase);
  let snapshot: PurchaseSnapshot;
  try {
    snapshot = await fetchPurchase(deps, provider, purchase, context);
  } catch (error) {
    return providerError(error);
  }
  return purchaseView(await recordSeenStatus(deps, purchase, snapshot), snapshot.card);
}

/** Only the bot that asked for it: its later runs are the ones that keep hiding what it typed. */
export function findBotPurchase(
  deps: Pick<PurchaseDeps, "prisma">,
  run: { spaceId: string; userId: string; botId: string },
  id: string,
): Promise<Purchase | null> {
  return deps.prisma.purchase.findFirst({
    where: { id, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
  });
}

export function inputError(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return {
    error: error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
      .join("; "),
  };
}

async function requestPurchase(
  deps: PurchaseDeps,
  provider: PaymentWalletProvider,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  args: Record<string, unknown>,
) {
  const parsed = PurchaseRequestInput.safeParse(args);
  if (!parsed.success) return inputError(parsed.error);
  const { merchantAccountId, ...request } = parsed.data;
  const credential: PurchaseCredential = merchantAccountId
    ? { kind: "pay_token", merchantAccountId }
    : { kind: "card", merchantName: request.merchantName, merchantUrl: request.merchantUrl };
  if (!walletSupports(provider, credential.kind))
    return { error: "The user's wallet can't pay with a pay token. Use the card instead." };
  return createPurchase(deps, provider, context, run, {
    credential,
    amount: request.amount,
    currency: request.currency,
    reason: request.reason,
    merchantName: request.merchantName,
    merchantUrl: request.merchantUrl,
  });
}

/**
 * Ask the wallet owner to approve a purchase and record it. `merchantUrl` is where it may be
 * used; for a pay token or HTTP payment it stays here and is never sent to the wallet.
 */
export async function createPurchase(
  deps: PurchaseDeps,
  provider: PaymentWalletProvider,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  request: {
    credential: PurchaseCredential;
    amount: number;
    currency: string;
    reason: string;
    merchantName: string;
    merchantUrl: string;
    paymentChallenge?: string;
    requestCiphertext?: string;
  },
) {
  const existing = await deps.prisma.purchase.findUnique({
    where: { operationKey: context.operationId },
  });
  if (existing) return purchaseView(ownedReplay(existing, context));
  // Counted against the spending limit before the wallet owner is asked, so two requests waiting at
  // once cannot both fit; released below or by the poller when no money moves.
  const refusal = await recordPayment(deps.prisma, {
    operationKey: context.operationId,
    userId: context.userId,
    spaceId: context.spaceId,
    botId: context.botId,
    threadId: run.threadId,
    site: new URL(request.merchantUrl).host,
    amount: request.amount,
    currency: request.currency,
  });
  if (refusal) return { error: spendingRefusalError(refusal) };
  let snapshot: PurchaseSnapshot;
  try {
    // The idempotency key makes a replay after a crash reuse the same remote purchase.
    snapshot = await withPurchaseWallet(deps, provider, context, (credential) =>
      provider.createPurchase(
        credential,
        {
          credential: request.credential,
          amount: request.amount,
          currency: request.currency,
          reason: request.reason,
          idempotencyKey: context.operationId,
        },
        context,
      ),
    );
  } catch (error) {
    // Only a wallet that turned the request down is known to hold nothing for it; after any other
    // failure the purchase may exist under its idempotency key, so it keeps counting.
    if (error instanceof PaymentWalletRequestRejected || error instanceof PaymentWalletDisconnected)
      await releasePayment(deps.prisma, context.operationId);
    return providerError(error);
  }
  await releaseUnpaidPurchase(deps.prisma, context.operationId, snapshot.status);
  const pending = PENDING_PURCHASE_STATUSES.has(snapshot.status);
  const thread = await deps.prisma.thread.findUniqueOrThrow({
    where: { id: run.threadId },
    select: { historyCompactionGeneration: true },
  });
  const purchase = ownedReplay(
    await deps.prisma.purchase.upsert({
      where: { operationKey: context.operationId },
      update: {},
      create: {
        operationKey: context.operationId,
        spaceId: context.spaceId,
        userId: context.userId,
        botId: context.botId,
        threadId: run.threadId,
        threadGeneration: thread.historyCompactionGeneration,
        provider: provider.describe().id,
        remoteId: snapshot.id,
        credentialType: request.credential.kind,
        merchantName: request.merchantName,
        merchantUrl: request.merchantUrl,
        merchantAccountId:
          request.credential.kind === "pay_token" ? request.credential.merchantAccountId : null,
        paymentChallenge: request.paymentChallenge ?? null,
        requestCiphertext: request.requestCiphertext ?? null,
        amount: request.amount,
        currency: request.currency,
        status: snapshot.status,
        approvalUrl: snapshot.approvalUrl ?? null,
        nextPollAt: pending ? new Date(Date.now() + PURCHASE_POLL_MS) : null,
        // The bot learns this status from the result; only later changes wake it.
        wokenStatus: snapshot.status,
      },
    }),
    context,
  );
  if (purchase.nextPollAt) await enqueuePurchasePoll(deps, purchase.id, purchase.nextPollAt);
  return purchaseView(purchase, snapshot.card);
}

function ownedReplay(purchase: Purchase, context: AdapterContext) {
  if (purchase.spaceId !== context.spaceId || purchase.userId !== context.userId)
    throw new Error("Purchase operation scope changed");
  return purchase;
}

/**
 * Save a status the bot just saw. It already knows it, so the poller does not wake it for
 * the same status. The updatedAt fence leaves a concurrent poll's newer write in place.
 */
export async function recordSeenStatus(
  deps: PurchaseDeps,
  purchase: Purchase,
  snapshot: PurchaseSnapshot,
) {
  if (snapshot.status === purchase.status) return purchase;
  const pending = PENDING_PURCHASE_STATUSES.has(snapshot.status);
  const data = {
    status: snapshot.status,
    approvalUrl: snapshot.approvalUrl ?? purchase.approvalUrl,
    wokenStatus: snapshot.status,
    nextPollAt: pending ? (purchase.nextPollAt ?? new Date()) : null,
  };
  const saved = await deps.prisma.purchase.updateMany({
    where: { id: purchase.id, updatedAt: purchase.updatedAt },
    data,
  });
  if (saved.count) await releaseUnpaidPurchase(deps.prisma, purchase.operationKey, snapshot.status);
  if (saved.count && data.nextPollAt) await enqueuePurchasePoll(deps, purchase.id, data.nextPollAt);
  return { ...purchase, ...data };
}

/** The row is the outbox; a queue failure leaves it due for reconcilePurchases. */
export async function enqueuePurchasePoll(
  deps: Pick<PurchaseDeps, "jobs">,
  purchaseId: string,
  availableAt?: Date,
) {
  await deps.jobs.enqueue(purchasePollJob(purchaseId, availableAt)).catch(() => {
    getLogger().warn("purchase poll deferred to reconciliation");
  });
}

export function purchaseContext(purchase: Purchase, use: string): AdapterContext {
  return {
    operationId: `purchase.${use}:${purchase.id}`,
    traceId: purchase.id,
    spaceId: purchase.spaceId,
    userId: purchase.userId,
    botId: purchase.botId,
    signal: AbortSignal.timeout(30_000),
  };
}

/**
 * The single-use card value browser_act fill_card types. Only the page fill path holds it;
 * `redactions` keep the number out of anything the run records afterwards.
 */
export async function resolvePurchaseCardFill(
  deps: Omit<PurchaseDeps, "jobs">,
  run: { spaceId: string; userId: string; botId: string },
  purchaseId: string,
  field: PurchaseCardField,
): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const provider = deps.paymentWallet;
  if (!provider) return NOT_CONFIGURED;
  const purchase = await findBotPurchase(deps, run, purchaseId);
  if (!purchase) return { error: "Unknown purchase." };
  if (purchase.status !== "approved") return NOT_APPROVED;
  if (credentialKind(purchase) !== "card")
    return { error: "This purchase pays without a card. Check purchase_status." };
  const context = purchaseContext(purchase, "card");
  const origin = new URL(purchase.merchantUrl).origin;
  if (field === "expiry" || field === "postal_code") {
    let card: PurchaseCardSummary | undefined;
    try {
      const snapshot = await fetchPurchase(deps, provider, purchase, context);
      if (snapshot.status === "approved") card = snapshot.card;
    } catch (error) {
      return providerError(error);
    }
    if (!card) return NOT_APPROVED;
    // Typed fills keep only the digits; a field filled directly gets the slash it expects.
    const text =
      field === "expiry"
        ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`
        : (card.billingAddress?.postalCode?.trim() ?? "");
    if (!text) return { error: "This card has no billing postal code." };
    return { text, origin, redactions: [] };
  }
  let secret: Awaited<ReturnType<PaymentWalletProvider["revealCard"]>>;
  try {
    secret = await withPurchaseWallet(deps, provider, purchase, (credential) =>
      provider.revealCard(credential, purchase.remoteId, context),
    );
  } catch (error) {
    return providerError(error);
  }
  const text = field === "number" ? secret.number : secret.cvc;
  if (!text) return { error: "This card has no security code." };
  // The page keeps the card after this run, so later runs on this bot hide it too.
  await sealOnce(deps, purchase, "cardCiphertext", secret.number, context);
  return { text, origin, redactions: cardRedactionForms(secret.number) };
}

/**
 * The approved pay token browser_act fill_pay_token hands to the checkout. Like a card, only the
 * page fill path holds it, and later runs of the bot keep hiding it.
 */
export async function resolvePurchasePayTokenFill(
  deps: Omit<PurchaseDeps, "jobs">,
  run: { spaceId: string; userId: string; botId: string },
  purchaseId: string,
): Promise<
  | { text: string; origin: string; merchantAccountId: string; redactions: string[] }
  | { error: string }
> {
  const provider = deps.paymentWallet;
  if (!provider) return NOT_CONFIGURED;
  const purchase = await findBotPurchase(deps, run, purchaseId);
  if (!purchase) return { error: "Unknown purchase." };
  if (credentialKind(purchase) !== "pay_token" || !purchase.merchantAccountId)
    return { error: "This purchase has no pay token. Check purchase_status." };
  if (purchase.status !== "approved") return NOT_APPROVED;
  const context = purchaseContext(purchase, "pay-token");
  let token: string;
  try {
    // Fetched right before use: the token is short-lived.
    token = await withPurchaseWallet(deps, provider, purchase, (credential) =>
      provider.revealPayToken(credential, purchase.remoteId, context),
    );
  } catch (error) {
    return providerError(error);
  }
  await sealOnce(deps, purchase, "tokenCiphertext", JSON.stringify([token]), context);
  return {
    text: token,
    origin: new URL(purchase.merchantUrl).origin,
    merchantAccountId: purchase.merchantAccountId,
    redactions: [token],
  };
}

/** Seal a purchase secret for later runs' redaction, once; a losing concurrent copy is deleted. */
export async function sealOnce(
  deps: WalletStoreDeps,
  purchase: Purchase,
  column: "cardCiphertext" | "tokenCiphertext",
  plaintext: string,
  context: AdapterContext,
) {
  if (purchase[column]) return;
  const recordId = sealedRecordId(purchase.id, column);
  const stored = await deps.secretStore.put(plaintext, context, { recordId });
  const saved = await deps.prisma.purchase
    .updateMany({
      where: { id: purchase.id, [column]: null },
      data: { [column]: stored.ciphertext },
    })
    .catch(() => ({ count: 0 }));
  if (!saved.count) await deleteSecretBestEffort(deps.secretStore, stored.ciphertext, { recordId });
}

function sealedRecordId(purchaseId: string, column: "cardCiphertext" | "tokenCiphertext") {
  return `${column === "cardCiphertext" ? "purchase-card" : "purchase-token"}:${purchaseId}`;
}

/** Single-use cards and tokens stop working well within this, and with them the reason to hide one. */
const REDACTION_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Every card and payment token this bot used recently. A checkout or API can keep or copy one
 * after the run that used it, so each run hides them before any tool output reaches the model.
 */
export async function loadPurchaseRedactions(
  deps: Pick<PurchaseDeps, "prisma" | "secretStore">,
  run: { spaceId: string; userId: string; botId: string },
): Promise<string[]> {
  const rows = await deps.prisma.purchase.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      OR: [{ cardCiphertext: { not: null } }, { tokenCiphertext: { not: null } }],
      createdAt: { gte: new Date(Date.now() - REDACTION_WINDOW_MS) },
    },
    select: { id: true, cardCiphertext: true, tokenCiphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    try {
      if (row.cardCiphertext) {
        const number = await deps.secretStore.load(row.cardCiphertext, {
          recordId: sealedRecordId(row.id, "cardCiphertext"),
        });
        for (const form of cardRedactionForms(number)) forms.add(form);
      }
      if (row.tokenCiphertext) {
        const tokens = JSON.parse(
          await deps.secretStore.load(row.tokenCiphertext, {
            recordId: sealedRecordId(row.id, "tokenCiphertext"),
          }),
        ) as unknown;
        for (const token of Array.isArray(tokens) ? tokens : [])
          if (typeof token === "string" && token) forms.add(token);
      }
    } catch {
      getLogger().warn("purchase redaction could not be loaded");
    }
  }
  return [...forms];
}

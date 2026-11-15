import { createHash } from "node:crypto";
import type {
  AdapterContext,
  HttpPaymentAuthorization,
  PaymentWalletProvider,
} from "@rakazo/adapter-kit";
import { PaidRequestInput } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Purchase } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "./connector-safety.js";
import type { PurchaseDeps } from "./purchase-service.js";
import {
  createPurchase,
  fetchPurchase,
  findBotPurchase,
  inputError,
  NOT_CONFIGURED,
  providerError,
  purchaseContext,
  purchaseView,
  recordSeenStatus,
  sealOnce,
  walletSupports,
  withPurchaseWallet,
} from "./purchase-service.js";
import type { SafeHttpResponse } from "./web-ssrf.js";
import { fetchSafeHttpRequest } from "./web-ssrf.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_CHARS = 50_000;
const MAX_PAYMENT_MINOR_UNITS = 100_000_000;

interface StoredRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

type PaidRequestResult = { result: unknown; redactions: string[] };

/** The amount always comes from the server's 402 challenge, never from the model. */
export async function executePaidRequest(
  deps: PurchaseDeps,
  context: AdapterContext & { botId: string },
  run: { threadId: string },
  args: Record<string, unknown>,
): Promise<PaidRequestResult> {
  const provider = deps.paymentWallet;
  if (!provider) return plain(NOT_CONFIGURED);
  const parsed = PaidRequestInput.safeParse(args);
  if (!parsed.success) return plain(inputError(parsed.error));
  if (!walletSupports(provider, "http_payment"))
    return plain({ error: "The user's wallet can't pay HTTP requests." });
  const input = parsed.data;
  if ("purchase" in input) return payApproved(deps, provider, context, input.purchase);

  const request: StoredRequest = {
    url: input.url,
    method: input.method,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
  const existing = await deps.prisma.purchase.findUnique({
    where: { operationKey: context.operationId },
  });
  if (existing) return plain(purchaseView(existing));
  let response: SafeHttpResponse;
  try {
    response = await send(deps, request, context.signal);
  } catch (error) {
    return plain(requestFailed(error, context));
  }
  if (response.status !== 402) return plain(responseView(response));
  const header = response.headers.get("www-authenticate");
  const challenge = header ? await provider.readHttpPaymentChallenge(header) : null;
  if (!challenge || challenge.amount > MAX_PAYMENT_MINOR_UNITS) {
    return plain({
      ...responseView(response),
      error: "The user's wallet can't pay what this request asks for.",
    });
  }
  // Headers and body can hold personal data or keys, so the request to send again is sealed.
  const recordId = `purchase-request:${context.operationId}`;
  const sealed = await deps.secretStore.put(JSON.stringify(request), context, { recordId });
  const url = new URL(request.url);
  const result = await createPurchase(deps, provider, context, run, {
    credential: { kind: "http_payment", challenge: challenge.challenge },
    amount: challenge.amount,
    currency: challenge.currency,
    reason: input.reason,
    merchantName: url.hostname,
    merchantUrl: `${url.origin}${url.pathname}`,
    paymentChallenge: challenge.challenge,
    requestCiphertext: sealed.ciphertext,
  });
  const saved = await deps.prisma.purchase.findUnique({
    where: { operationKey: context.operationId },
    select: { requestCiphertext: true },
  });
  if (saved?.requestCiphertext !== sealed.ciphertext) {
    await deps.secretStore.delete(sealed.ciphertext, { recordId }).catch(() => undefined);
  }
  return plain(result);
}

async function payApproved(
  deps: PurchaseDeps,
  provider: PaymentWalletProvider,
  context: AdapterContext & { botId: string },
  id: string,
): Promise<PaidRequestResult> {
  let purchase = await findBotPurchase(deps, context, id);
  if (!purchase) return plain({ error: "Unknown purchase." });
  if (purchase.credentialType !== "http_payment" || !purchase.requestCiphertext)
    return plain({ error: "This purchase is not for a paid request. Check purchase_status." });
  if (purchase.status === "completed" || purchase.status === "failed") {
    return plain({
      error:
        "This purchase was already used. To pay again, call paid_request with the request, which asks the user again.",
    });
  }
  if (purchase.status !== "approved") {
    try {
      purchase = await recordSeenStatus(
        deps,
        purchase,
        await fetchPurchase(deps, provider, purchase, context),
      );
    } catch (error) {
      return plain(providerError(error));
    }
    if (purchase.status !== "approved") return plain(purchaseView(purchase));
  }
  const request = JSON.parse(
    await deps.secretStore.load(purchase.requestCiphertext!, {
      recordId: `purchase-request:${purchase.operationKey}`,
    }),
  ) as StoredRequest;

  let response: SafeHttpResponse;
  try {
    response = await send(deps, request, context.signal);
  } catch (error) {
    return plain(requestFailed(error, context));
  }
  const header = response.headers.get("www-authenticate");
  if (response.status !== 402 || !header) {
    return plain({ ...responseView(response), note: "The server did not ask for payment." });
  }
  const approved = purchase;
  let authorization: HttpPaymentAuthorization;
  try {
    authorization = await withPurchaseWallet(deps, provider, approved, (credential) =>
      provider.authorizeHttpPayment(
        credential,
        approved.remoteId,
        approved.paymentChallenge ?? "",
        header,
        context,
      ),
    );
  } catch (error) {
    return plain(providerError(error));
  }
  const redactions = [...authorization.secrets, ...Object.values(authorization.headers)];
  await sealOnce(
    deps,
    approved,
    "tokenCiphertext",
    JSON.stringify(redactions),
    purchaseContext(approved, "http-payment"),
  );
  // The token is single use: claim the purchase before sending it, so a concurrent call can't.
  const claimed = await deps.prisma.purchase.updateMany({
    where: { id: approved.id, status: "approved" },
    data: { status: "completed", wokenStatus: "completed", nextPollAt: null },
  });
  if (!claimed.count) return plain({ error: "This purchase was already used." });

  let paid: SafeHttpResponse;
  try {
    paid = await send(deps, request, context.signal, authorization.headers);
  } catch (error) {
    context.signal.throwIfAborted();
    getLogger().warn("paid request did not finish", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return {
      result: {
        id: approved.id,
        status: "completed",
        error:
          "The paid request did not finish, so it is unknown whether the payment went through. Ask the user before paying again.",
      },
      redactions,
    };
  }
  const accepted = paid.status >= 200 && paid.status < 300;
  if (!accepted) await markFailed(deps, approved);
  return {
    result: redactConnectorPayload(
      {
        purchase: { id: approved.id, status: accepted ? "completed" : "failed" },
        ...responseView(paid, redactions),
        ...(accepted
          ? {}
          : {
              note: "The payment token is spent. To try again, call paid_request with the request, which asks the user again.",
            }),
      },
      redactions,
    ),
    redactions,
  };
}

async function markFailed(deps: PurchaseDeps, purchase: Purchase) {
  await deps.prisma.purchase.updateMany({
    where: { id: purchase.id, status: "completed" },
    data: { status: "failed", wokenStatus: "failed" },
  });
}

function send(
  deps: PurchaseDeps,
  request: StoredRequest,
  signal: AbortSignal,
  payment: Record<string, string> = {},
) {
  return fetchSafeHttpRequest(
    request.url,
    { method: request.method, headers: { ...request.headers, ...payment }, body: request.body },
    {
      ...deps.paidRequestFetch,
      allowedPorts: [443],
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 30_000,
      signal,
    },
  );
}

/** The response as untrusted text, like a fetched page. Redirects are reported, not followed. */
/** The effect log keeps a digest of headers and body: they can hold personal data, sealed elsewhere. */
export function paidRequestEffect(args: Record<string, unknown>): Record<string, unknown> {
  const { headers, body, ...rest } = args;
  if (headers === undefined && body === undefined) return args;
  return { ...rest, sealed: requestDigest(headers, body) };
}

/** An approved replay runs only with the headers and body whose digest was approved. */
export function restorePaidRequest(
  approved: Record<string, unknown>,
  live: Record<string, unknown>,
): Record<string, unknown> | { error: string } {
  const { sealed, ...rest } = approved;
  if (sealed === undefined) return approved;
  if (requestDigest(live.headers, live.body) !== sealed)
    return { error: "The request changed after approval. Call paid_request again." };
  return {
    ...rest,
    ...(live.headers !== undefined ? { headers: live.headers } : {}),
    ...(live.body !== undefined ? { body: live.body } : {}),
  };
}

function requestDigest(headers: unknown, body: unknown): string {
  return createHash("sha256").update(stableJsonValue({ headers, body })).digest("hex");
}

function responseView(response: SafeHttpResponse, secrets: string[] = []) {
  const text = hideSecrets(new TextDecoder().decode(response.body), secrets, response.truncated);
  const location = response.headers.get("location");
  return {
    status: response.status,
    ...(response.headers.get("content-type")
      ? { contentType: response.headers.get("content-type") }
      : {}),
    ...(response.status >= 300 && response.status < 400 && location ? { location } : {}),
    body: text.slice(0, MAX_RESPONSE_CHARS),
    ...(response.truncated || text.length > MAX_RESPONSE_CHARS ? { truncated: true } : {}),
  };
}

/** Secrets go before any cut, and a body cut at the byte limit drops a secret's leading part too. */
function hideSecrets(text: string, secrets: string[], cutShort: boolean | undefined): string {
  let hidden = String(redactConnectorPayload(text, secrets));
  if (!cutShort) return hidden;
  for (const secret of secrets) {
    for (let length = secret.length - 1; length >= 4; length -= 1) {
      if (hidden.endsWith(secret.slice(0, length))) {
        hidden = hidden.slice(0, -length);
        break;
      }
    }
  }
  return hidden;
}

function requestFailed(error: unknown, context: AdapterContext) {
  context.signal.throwIfAborted();
  return { error: error instanceof Error ? error.message : "The request failed." };
}

function plain(result: unknown): PaidRequestResult {
  return { result, redactions: [] };
}

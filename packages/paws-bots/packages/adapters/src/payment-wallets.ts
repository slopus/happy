import type {
  AdapterContext,
  PaymentWalletCredential,
  PaymentWalletProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import { PaymentWalletDisconnected, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { PaymentWalletStatus } from "@rakazo/contracts";
import type { PaymentWallet, Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";
import { withRefreshLock } from "./refresh-lock.js";
import { deleteSecretBestEffort, holdSecretNotifications } from "./secret-store-factory.js";

export interface PaymentWalletDeps {
  prisma: PrismaClient;
  secretStore: SecretStore;
  paymentWallet: PaymentWalletProvider | null | undefined;
}

type WalletActor = { userId: string; spaceId: string };

/** What the secret store holds for a wallet row: a pending sign-in or the credential. */
type WalletMaterial = { state: string; intervalMs: number } | { secret: string };

/** Refresh a little before the provider asks, to cover clock skew and request time. */
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 30_000;
/** A sign-in check holds its claim past the provider timeout, so checks never overlap. */
const POLL_CLAIM_MS = PROVIDER_TIMEOUT_MS + 5_000;
/** RFC 8628: each slow_down adds five seconds to the polling interval. */
const SLOW_DOWN_STEP_MS = 5_000;

const DISCONNECTED: PaymentWalletStatus = { status: "disconnected" };

function recordId(userId: string): string {
  return `payment-wallet:${userId}`;
}

function providerContext(actor: WalletActor, operation: string): AdapterContext {
  return {
    operationId: `payment-wallet.${operation}`,
    traceId: `payment-wallet.${operation}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  };
}

/** Error names only: provider errors may quote tokens or response bodies. */
function warn(message: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  getLogger().warn(`${message}: ${name}`);
}

/** Serializes credential changes for one user across the API and worker. */
function lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<unknown> {
  return advisoryLock(tx, "payment-wallet", userId);
}

async function storeMaterial(
  deps: PaymentWalletDeps,
  actor: WalletActor,
  material: WalletMaterial,
): Promise<string> {
  const stored = await deps.secretStore.put(
    JSON.stringify(material),
    providerContext(actor, "persist"),
    { recordId: recordId(actor.userId) },
  );
  return stored.ciphertext;
}

/** Null when the stored material is unreadable; a store outage still throws. */
async function readMaterial(
  deps: PaymentWalletDeps,
  row: Pick<PaymentWallet, "userId" | "ciphertext">,
): Promise<WalletMaterial | null> {
  try {
    const value: unknown = JSON.parse(
      await deps.secretStore.load(row.ciphertext, { recordId: recordId(row.userId) }),
    );
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.secret === "string") return { secret: record.secret };
      if (typeof record.state === "string")
        return {
          state: record.state,
          intervalMs:
            typeof record.intervalMs === "number" ? record.intervalMs : DEFAULT_POLL_INTERVAL_MS,
        };
    }
    return null;
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return null;
  }
}

function dropSecret(deps: PaymentWalletDeps, userId: string, ciphertext: string): Promise<void> {
  return deleteSecretBestEffort(deps.secretStore, ciphertext, recordId(userId));
}

/** The user's wallet row for the configured provider; one for another provider counts as none. */
async function currentWallet(
  deps: PaymentWalletDeps,
  userId: string,
): Promise<PaymentWallet | null> {
  if (!deps.paymentWallet) return null;
  const row = await deps.prisma.paymentWallet.findUnique({ where: { userId } });
  return row && row.provider === deps.paymentWallet.describe().id ? row : null;
}

function statusOf(row: PaymentWallet | null): PaymentWalletStatus {
  if (row?.status === "connected" && row.connectedAt)
    return { status: "connected", connectedAt: row.connectedAt.toISOString() };
  if (row?.status === "connecting" && row.verificationUrl && row.expiresAt)
    return {
      status: "connecting",
      verificationUrl: row.verificationUrl,
      userCode: row.userCode ?? "",
      expiresAt: row.expiresAt.toISOString(),
    };
  return DISCONNECTED;
}

/** Deletes the row only while it still holds `ciphertext`, so a newer connect survives. */
async function removeWallet(deps: PaymentWalletDeps, row: PaymentWallet): Promise<void> {
  const { count } = await deps.prisma.paymentWallet.deleteMany({
    where: { id: row.id, ciphertext: row.ciphertext },
  });
  if (count) await dropSecret(deps, row.userId, row.ciphertext);
}

/** Revokes a connected row's credential with the provider; failures only log. */
async function revokeBestEffort(
  deps: PaymentWalletDeps,
  actor: WalletActor,
  row: PaymentWallet,
): Promise<void> {
  const provider = deps.paymentWallet;
  if (!provider || row.status !== "connected" || row.provider !== provider.describe().id) return;
  try {
    const material = await readMaterial(deps, row);
    if (!material || !("secret" in material)) return;
    await provider.disconnect(
      { secret: material.secret, refreshAt: row.refreshAt },
      providerContext(actor, "disconnect"),
    );
  } catch (error) {
    warn("Payment wallet revoke failed", error);
  }
}

/** Removes whatever wallet row the user has, then revokes and forgets its credential. */
async function replaceWallet(
  deps: PaymentWalletDeps,
  actor: WalletActor,
  write: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  const previous = await deps.prisma.$transaction(async (tx) => {
    await lockWallet(tx, actor.userId);
    const row = await tx.paymentWallet.findUnique({ where: { userId: actor.userId } });
    await write(tx);
    return row;
  });
  if (!previous) return;
  await revokeBestEffort(deps, actor, previous);
  await dropSecret(deps, actor.userId, previous.ciphertext);
}

/** Wallet status for Settings; advances a pending sign-in when its next check is due. */
export async function paymentWalletStatus(
  deps: PaymentWalletDeps,
  actor: WalletActor,
  options: { onConnected?: () => Promise<void> } = {},
): Promise<PaymentWalletStatus> {
  const provider = deps.paymentWallet;
  const row = await currentWallet(deps, actor.userId);
  if (!provider || !row || row.status !== "connecting") return statusOf(row);
  const now = new Date();
  if (!row.expiresAt || row.expiresAt <= now) {
    await removeWallet(deps, row);
    return DISCONNECTED;
  }
  if (row.nextPollAt && row.nextPollAt > now) return statusOf(row);
  const material = await readMaterial(deps, row);
  if (!material || !("state" in material)) {
    await removeWallet(deps, row);
    return DISCONNECTED;
  }
  // Claim this check so concurrent readers do not poll the provider twice.
  const { count } = await deps.prisma.paymentWallet.updateMany({
    where: {
      id: row.id,
      ciphertext: row.ciphertext,
      status: "connecting",
      nextPollAt: row.nextPollAt,
    },
    data: { nextPollAt: new Date(now.getTime() + POLL_CLAIM_MS) },
  });
  const intervalMs = Math.max(row.pollIntervalMs ?? material.intervalMs, 1_000);
  if (!count) return statusOf(await currentWallet(deps, actor.userId));
  let result: Awaited<ReturnType<PaymentWalletProvider["pollConnect"]>>;
  try {
    result = await provider.pollConnect(material.state, providerContext(actor, "poll"));
  } catch (error) {
    warn("Payment wallet sign-in check failed", error);
    await releasePoll(deps, row, intervalMs);
    return statusOf(row);
  }
  if (result.status === "pending") {
    await releasePoll(deps, row, result.slowDown ? intervalMs + SLOW_DOWN_STEP_MS : intervalMs);
    return statusOf(row);
  }
  if (result.status !== "connected") {
    await removeWallet(deps, row);
    return DISCONNECTED;
  }
  const ciphertext = await storeMaterial(deps, actor, { secret: result.credential.secret });
  const connectedAt = new Date();
  let failure: unknown;
  const stored = await deps.prisma.paymentWallet
    .updateMany({
      where: { id: row.id, ciphertext: row.ciphertext },
      data: {
        status: "connected",
        ciphertext,
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        nextPollAt: null,
        refreshAt: result.credential.refreshAt,
        connectedAt,
      },
    })
    .catch((error: unknown) => {
      failure = error;
      return { count: 0 };
    });
  if (!stored.count) {
    // A disconnect or new sign-in landed meanwhile, or the save failed: nothing holds this
    // credential, so it is forgotten and revoked.
    await dropSecret(deps, actor.userId, ciphertext);
    try {
      await provider.disconnect(result.credential, providerContext(actor, "disconnect"));
    } catch (error) {
      warn("Payment wallet revoke failed", error);
    }
    if (failure) throw failure;
    return statusOf(await currentWallet(deps, actor.userId));
  }
  await dropSecret(deps, actor.userId, row.ciphertext);
  await options.onConnected?.();
  return { status: "connected", connectedAt: connectedAt.toISOString() };
}

/** Ends a sign-in check: the next one may start after `intervalMs`. */
async function releasePoll(deps: PaymentWalletDeps, row: PaymentWallet, intervalMs: number) {
  await deps.prisma.paymentWallet.updateMany({
    where: { id: row.id, ciphertext: row.ciphertext, status: "connecting" },
    data: { nextPollAt: new Date(Date.now() + intervalMs), pollIntervalMs: intervalMs },
  });
}

/** Starts a sign-in the user finishes with the provider, replacing any wallet already connected. */
export async function connectPaymentWallet(
  deps: PaymentWalletDeps,
  actor: WalletActor,
): Promise<PaymentWalletStatus> {
  const provider = deps.paymentWallet;
  if (!provider) throw new Error("No payment wallet is configured");
  const start = await provider.beginConnect(
    { clientName: "Rakazo" },
    providerContext(actor, "connect"),
  );
  const ciphertext = await storeMaterial(deps, actor, {
    state: start.state,
    intervalMs: start.intervalMs,
  });
  const fields = {
    provider: provider.describe().id,
    status: "connecting",
    ciphertext,
    verificationUrl: start.verificationUrl,
    userCode: start.userCode,
    expiresAt: start.expiresAt,
    nextPollAt: new Date(Date.now() + Math.max(start.intervalMs, 1_000)),
    pollIntervalMs: start.intervalMs,
    refreshAt: null,
    connectedAt: null,
  };
  try {
    await replaceWallet(deps, actor, (tx) =>
      tx.paymentWallet.upsert({
        where: { userId: actor.userId },
        create: { userId: actor.userId, ...fields },
        update: fields,
      }),
    );
  } catch (error) {
    await dropSecret(deps, actor.userId, ciphertext);
    throw error;
  }
  return {
    status: "connecting",
    verificationUrl: start.verificationUrl,
    userCode: start.userCode,
    expiresAt: start.expiresAt.toISOString(),
  };
}

/** Revokes the wallet with the provider when it can and forgets it either way. */
export async function disconnectPaymentWallet(
  deps: PaymentWalletDeps,
  actor: WalletActor,
): Promise<PaymentWalletStatus> {
  await replaceWallet(deps, actor, (tx) =>
    tx.paymentWallet.deleteMany({ where: { userId: actor.userId } }),
  );
  return DISCONNECTED;
}

export async function paymentWalletConnected(
  deps: PaymentWalletDeps,
  userId: string,
): Promise<boolean> {
  return (await currentWallet(deps, userId))?.status === "connected";
}

type Refreshed =
  | { credential: PaymentWalletCredential; row: PaymentWallet; replaced?: string }
  | { revoked: PaymentWallet }
  | { gone: true };

/**
 * Refreshes under the user's wallet lock. Providers rotate refresh credentials, so a
 * credential another process already refreshed is adopted instead of spent twice.
 */
async function refreshCredential(
  deps: PaymentWalletDeps,
  provider: PaymentWalletProvider,
  actor: WalletActor,
  held: PaymentWallet,
): Promise<{ credential: PaymentWalletCredential; row: PaymentWallet }> {
  let written: string | undefined;
  let result: Refreshed;
  try {
    result = await withRefreshLock(
      deps.prisma,
      (tx) => lockWallet(tx, actor.userId),
      async (tx): Promise<Refreshed> => {
        const row = await tx.paymentWallet.findUnique({ where: { userId: actor.userId } });
        if (row?.status !== "connected" || row.provider !== provider.describe().id)
          return { gone: true };
        const material = await readMaterial(deps, row);
        if (!material || !("secret" in material)) return { revoked: row };
        const credential = { secret: material.secret, refreshAt: row.refreshAt };
        if (row.ciphertext !== held.ciphertext || !refreshDue(row.refreshAt))
          return { credential, row };
        let next: PaymentWalletCredential;
        try {
          next = await provider.refresh(credential, providerContext(actor, "refresh"));
        } catch (error) {
          if (error instanceof PaymentWalletDisconnected) return { revoked: row };
          throw error;
        }
        written = await storeMaterial(deps, actor, { secret: next.secret });
        const updated = await tx.paymentWallet.update({
          where: { id: row.id },
          data: { ciphertext: written, refreshAt: next.refreshAt },
        });
        return { credential: next, row: updated, replaced: row.ciphertext };
      },
    );
  } catch (error) {
    if (written) await dropSecret(deps, actor.userId, written);
    throw error;
  }
  if ("gone" in result) throw new PaymentWalletDisconnected();
  if ("revoked" in result) {
    await removeWallet(deps, result.revoked);
    throw new PaymentWalletDisconnected();
  }
  if (result.replaced) await dropSecret(deps, actor.userId, result.replaced);
  return result;
}

function refreshDue(refreshAt: Date | null): boolean {
  return Boolean(refreshAt && refreshAt.getTime() - REFRESH_SKEW_MS <= Date.now());
}

/** Loads the user's credential, refreshing it under a lock when due; throws PaymentWalletDisconnected if none or revoked. */
export async function withPaymentWalletCredential<T>(
  deps: PaymentWalletDeps,
  actor: WalletActor,
  fn: (credential: PaymentWalletCredential) => Promise<T>,
): Promise<T> {
  const provider = deps.paymentWallet;
  let row = await currentWallet(deps, actor.userId);
  if (!provider || !row || row.status !== "connected") throw new PaymentWalletDisconnected();
  let credential: PaymentWalletCredential;
  if (refreshDue(row.refreshAt)) {
    // The refresh writes its secret inside the lock transaction, so the change notification
    // waits for that pooled connection to come back.
    const held = row;
    ({ credential, row } = await holdSecretNotifications(() =>
      refreshCredential(deps, provider, actor, held),
    ));
  } else {
    const material = await readMaterial(deps, row);
    if (!material || !("secret" in material)) {
      await removeWallet(deps, row);
      throw new PaymentWalletDisconnected();
    }
    credential = { secret: material.secret, refreshAt: row.refreshAt };
  }
  try {
    return await fn(credential);
  } catch (error) {
    if (error instanceof PaymentWalletDisconnected) await removeWallet(deps, row);
    throw error;
  }
}

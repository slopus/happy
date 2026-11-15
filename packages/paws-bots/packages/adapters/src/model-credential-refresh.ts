import type {
  AgentModelOAuthCredential,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { retireModelCredential } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";
import { parseModelSecret, serializeModelSecret } from "./model-secret.js";
import type { ResolveModelOpts } from "./pi-oauth.js";
import {
  loadProviderOAuth,
  MIN_OAUTH_VALIDITY_MS,
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  OAUTH_RECONNECT_REQUIRED_ERROR,
  RetiredModelCredentialError,
  resolveModelAuth,
} from "./pi-oauth.js";
import { REFRESH_REQUEST_TIMEOUT_MS, withRefreshLock } from "./refresh-lock.js";
import { holdSecretNotifications } from "./secret-store-factory.js";

/** Bound on a detached credential refresh so it cannot pin the shared lock. */
const REFRESH_KICK_TIMEOUT_MS = 30_000;
/**
 * pi-ai ends a running run's refresh at 15 s itself (auth/resolve.js, not exported), on a
 * timer that starts after ours: this backstop must not fire first and drop a rotated token.
 */
const RUNTIME_REFRESH_BACKSTOP_MS = REFRESH_REQUEST_TIMEOUT_MS + 5_000;

const modelCredentialLocks = new Map<string, Promise<void>>();

/** Concurrent runs and refresh kicks must not double-refresh or clobber each other's token write. */
export async function withModelCredentialLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = modelCredentialLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  modelCredentialLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (modelCredentialLocks.get(key) === current) modelCredentialLocks.delete(key);
  }
}

/**
 * Retire callback for `resolveModelAuth`. `retireModelCredential` fences against
 * newer material; a confirmed failure swaps the rejected tokens for a reconnect
 * marker that keeps the connection's settings. Whichever stored copy ends up
 * unreferenced is deleted.
 */
export function retireToReconnectMarker(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "put" | "load" | "delete">,
  scope: { userId: string; spaceId: string },
  credential: { id: string; secretId: string },
  maxTokens: number | undefined,
) {
  return async (
    _reason: ModelCredentialRetireReason,
    _detail: string | undefined,
    failed?: ModelCredentialFailedState,
  ): Promise<boolean> => {
    const previous = (
      await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: scope.userId, spaceId: null },
        select: { ciphertext: true },
      })
    )?.ciphertext;
    const replacement = await secretStore.put(
      serializeModelSecret({
        kind: "oauth",
        reconnectRequired: true,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }),
      {
        operationId: "cred",
        traceId: "cred-reconnect",
        spaceId: scope.spaceId,
        userId: scope.userId,
        signal: new AbortController().signal,
      },
      { recordId: credential.secretId },
    );
    let replaced = false;
    try {
      const retired = await retireModelCredential(prisma, {
        userId: scope.userId,
        credentialId: credential.id,
        secretId: credential.secretId,
        replacementCiphertext: replacement.ciphertext,
        matchesFailedSecret: failed
          ? matchesFailedOAuthSecret(
              (ciphertext, secretId) => secretStore.load(ciphertext, secretId),
              failed,
            )
          : undefined,
      });
      replaced = retired && previous !== undefined;
      return retired;
    } finally {
      const unused = replaced ? previous : replacement.ciphertext;
      if (unused) await secretStore.delete(unused, credential.secretId).catch(() => undefined);
    }
  };
}

function oauthRefreshDue(plaintext: string, now: number): boolean {
  try {
    const parsed = parseModelSecret(plaintext);
    return (
      parsed.kind === "oauth" &&
      !parsed.reconnectRequired &&
      parsed.credential.expires - now < MIN_OAUTH_VALIDITY_MS
    );
  } catch {
    return false;
  }
}

function lockModelCredential(tx: Prisma.TransactionClient, secretId: string): Promise<unknown> {
  return advisoryLock(tx, "model-credential", secretId);
}

/**
 * `resolveModelAuth` for a stored credential. Providers rotate refresh tokens, so a
 * due refresh runs under a database lock against the stored copy: an instance whose
 * copy another instance already refreshed adopts the stored token instead of
 * spending the rotated one. The refreshed token is written on the lock's own
 * connection, so a refresh never waits for a second one to save it. With
 * `credential.id`, a terminal failure retires the credential after the lock's
 * transaction ends, in retirement's own fenced transaction.
 */
export async function resolveStoredModelAuth(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "load" | "put" | "delete">,
  scope: { userId: string; spaceId: string },
  credential: { id?: string; secretId: string },
  plaintext: string,
  provider: string,
  opts: Pick<ResolveModelOpts, "oauth" | "signal" | "now"> = {},
): ReturnType<typeof resolveModelAuth> {
  // One clock reading, so the locked and unlocked paths agree on whether a refresh is due.
  const now = opts.now ?? Date.now();
  opts = { ...opts, now };
  if (!oauthRefreshDue(plaintext, now)) {
    return resolveModelAuth(plaintext, provider, opts);
  }
  const { secretId } = credential;
  let failure:
    | { args: Parameters<NonNullable<ResolveModelOpts["retire"]>>; maxTokens?: number }
    | undefined;
  try {
    // The token write announces itself once the lock's connection is back.
    const outcome = await holdSecretNotifications(() =>
      withRefreshLock(
        prisma,
        (tx) => lockModelCredential(tx, secretId),
        async (tx) => {
          const row = await tx.secret.findUnique({
            where: { id: secretId },
            select: { ciphertext: true },
          });
          // A disconnect removed the sign-in meanwhile: never spend its old token.
          if (!row) throw new Error("Connect that model provider again.");
          const stored = await secretStore.load(row.ciphertext, secretId);
          const timeout = AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS);
          const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
          let saved = false;
          // A failure after the save still commits it: the provider spent the old token.
          return resolveModelAuth(stored, provider, {
            ...opts,
            signal,
            persist: async (next) => {
              await persistStoredModelSecret(tx, secretStore, scope, secretId)(next);
              saved = true;
            },
            // Recorded only: retiring needs the lock's connection released first.
            retire: async (...args) => {
              failure = { args, maxTokens: parseModelSecret(stored).maxTokens };
              return false;
            },
          }).then(
            (resolved) => ({ resolved }),
            (error) => (saved ? { error } : Promise.reject(error)),
          );
        },
      ),
    );
    if ("error" in outcome) throw outcome.error;
    return outcome.resolved;
  } catch (error) {
    if (!failure || !credential.id) throw error;
    const [reason] = failure.args;
    let deleted = false;
    try {
      deleted =
        (await retireToReconnectMarker(
          prisma,
          secretStore,
          scope,
          { id: credential.id, secretId },
          failure.maxTokens,
        )(...failure.args)) === true;
    } catch (retireError) {
      getLogger().error("model credential retirement failed", retireError);
    }
    if (!deleted) throw error;
    throw new RetiredModelCredentialError(
      reason === "account-changed" ? OAUTH_ACCOUNT_CHANGED_ERROR : OAUTH_RECONNECT_REQUIRED_ERROR,
    );
  }
}

/**
 * The run's own refresh of the stored credential it started with, coordinated like
 * every other refresh. `refresh` is the runtime's refresh of the stored copy.
 */
export function refreshStoredModelCredential(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "load" | "put" | "delete">,
  scope: { userId: string; spaceId: string },
  credential: { id: string; secretId: string },
  provider: string,
  opts?: Pick<ResolveModelOpts, "oauth">,
) {
  return async (
    held: AgentModelOAuthCredential,
    refresh: (
      stored: AgentModelOAuthCredential,
      signal: AbortSignal,
    ) => Promise<AgentModelOAuthCredential | undefined>,
  ): Promise<AgentModelOAuthCredential> => {
    const toAuth = (opts?.oauth ?? loadProviderOAuth(provider))?.toAuth;
    const resolved = await withModelCredentialLock(credential.secretId, () =>
      resolveStoredModelAuth(
        prisma,
        secretStore,
        scope,
        credential,
        serializeModelSecret({ kind: "oauth", credential: { ...held } }),
        provider,
        toAuth
          ? {
              oauth: {
                refresh: async (stored) => {
                  const next = await refresh(
                    stored,
                    AbortSignal.timeout(RUNTIME_REFRESH_BACKSTOP_MS),
                  );
                  return next ? { ...next } : stored;
                },
                toAuth: (next) => toAuth(next),
              },
            }
          : {},
      ),
    );
    if (resolved.secret.kind !== "oauth") throw new Error(OAUTH_RECONNECT_REQUIRED_ERROR);
    return resolved.secret.credential;
  };
}

/** The only token writer, shared by the run path and the detached refresh kick. */
export function persistStoredModelSecret(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "put">,
  scope: { userId: string; spaceId: string },
  secretId: string,
): (next: string) => Promise<void> {
  return async (next) => {
    const stored = await secretStore.put(
      next,
      {
        operationId: "cred",
        traceId: "cred-refresh",
        spaceId: scope.spaceId,
        userId: scope.userId,
        signal: new AbortController().signal,
      },
      { recordId: secretId },
    );
    await prisma.secret.update({
      where: { id: secretId },
      data: { ciphertext: stored.ciphertext },
    });
  };
}

/**
 * `resolveModelAuth` refreshes only a near-expiry credential, so a kick queued
 * behind a run's own refresh is a no-op once the stored token is fresh.
 */
export async function refreshExpiredModelCredential(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "load" | "put" | "delete">,
  scope: { userId: string; spaceId: string },
  secretId: string,
  provider: string,
  opts?: Pick<ResolveModelOpts, "oauth" | "signal" | "now">,
): Promise<void> {
  await withModelCredentialLock(secretId, async () => {
    const row = await prisma.secret.findFirst({
      where: { id: secretId, userId: scope.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (!row) return;
    let plaintext: string;
    try {
      plaintext = await secretStore.load(row.ciphertext, row.id);
      const parsed = parseModelSecret(plaintext);
      if (parsed.kind !== "oauth" || parsed.reconnectRequired) return;
    } catch {
      return;
    }
    await resolveStoredModelAuth(
      prisma,
      secretStore,
      scope,
      { secretId: row.id },
      plaintext,
      provider,
      opts,
    );
  });
}

const credentialRefreshKicks = new Map<string, Promise<void>>();

/** Concurrent kicks for one credential collapse into a single refresh. */
export function kickModelCredentialRefresh(
  prisma: Pick<PrismaClient, "$transaction" | "secret">,
  secretStore: Pick<SecretStore, "load" | "put" | "delete">,
  scope: { userId: string; spaceId: string },
  secretId: string,
  provider: string,
  opts?: Pick<ResolveModelOpts, "oauth" | "signal" | "now">,
): void {
  if (credentialRefreshKicks.has(secretId)) return;
  const kick = refreshExpiredModelCredential(prisma, secretStore, scope, secretId, provider, {
    signal: opts?.signal ?? AbortSignal.timeout(REFRESH_KICK_TIMEOUT_MS),
    ...(opts?.oauth ? { oauth: opts.oauth } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
  })
    .catch(() => undefined)
    .finally(() => {
      if (credentialRefreshKicks.get(secretId) === kick) {
        credentialRefreshKicks.delete(secretId);
      }
    });
  credentialRefreshKicks.set(secretId, kick);
}

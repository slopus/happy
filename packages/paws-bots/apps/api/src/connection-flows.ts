import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { ConnectorAuthUnavailableError } from "@rakazo/adapter-kit";
import {
  advisoryLock,
  pickReusableConnection,
  prepareManagedConnectorForTransaction,
  sanitizeIntegrationError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { isIntegrationProviderId } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  ProviderTransactionBusyError,
  recordSecurityEvent,
  runProviderTransaction,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import { connectionCreatedEvent } from "./security-audit.js";

function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

/** Connection flows hold the provider lock across provider calls (45s budget plus database work). */
const PROVIDER_LOCK_TRANSACTION_MS = 60_000;

/**
 * The scope one connection flow serializes on: one user's rows for one provider. The
 * advisory locks and the provider transaction gate share it, so the gate queues only
 * behind work the database would serialize anyway.
 */
export function providerScopeKey(
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): string {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  return `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
}

async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  await advisoryLock(tx, "connection-provider", providerScopeKey(owner, connectorId, provider));
}

/** Like lockProviderConnectionScope, but returns false instead of waiting for a holder. */
async function tryLockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext('connection-provider'), hashtext(${providerScopeKey(owner, connectorId, provider)})) AS locked`;
  return row?.locked === true;
}

/**
 * A provider-lock transaction, run through the provider transaction gate keyed to its
 * scope, so a slow provider pins at most one pooled connection per scope and a bounded
 * share of the pool overall, however many requests are waiting.
 */
function providerLockTransaction<T>(
  prisma: PrismaClient,
  scope: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  waitMs = PROVIDER_LOCK_TRANSACTION_MS,
): Promise<T> {
  return runProviderTransaction(
    scope,
    () => prisma.$transaction(fn, { timeout: PROVIDER_LOCK_TRANSACTION_MS }),
    waitMs,
  );
}

/** How long a poll of connections/complete waits for the slot before reporting the row as is. */
const COMPLETE_POLL_SLOT_WAIT_MS = 2_000;

export function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export async function beginConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectorId: string; provider: string; displayName: string },
) {
  const connector =
    deps.integrationSettings && isIntegrationProviderId(input.connectorId)
      ? await deps.integrationSettings.resolve(input.connectorId)
      : deps.connectors.managed(input.connectorId);
  if (!connector) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Connector ${input.connectorId} is not configured`,
    });
  }
  // Share the revoke scope lock so a slug-wide remote delete cannot miss a
  // row that is inserted after SELECT FOR UPDATE and before remote revoke.
  // Complete and revoke hold that lock across provider calls, so wait as long as they may.
  const row = await providerLockTransaction(
    deps.prisma,
    providerScopeKey(context.actor, input.connectorId, input.provider),
    async (tx) => {
      await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
      const existing = await tx.connection.findMany({
        where: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: input.connectorId,
          provider: input.provider,
        },
        select: { id: true, status: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
      const reusable = pickReusableConnection(existing);
      if (reusable) {
        return tx.connection.update({
          where: { id: reusable.id },
          data: {
            displayName: input.displayName,
            status: "pending",
            providerRef: null,
            metadata: {},
          },
        });
      }
      return tx.connection.create({
        data: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: input.connectorId,
          provider: input.provider,
          displayName: input.displayName,
          status: "pending",
        },
      });
    },
  );
  try {
    const auth = await connector.begin(
      {
        provider: input.provider,
        redirectUrl: `${deps.env.webOrigin}/integrations/callback`,
      },
      connectionContext(context.actor, "connections.begin", context.signal),
    );
    // Re-take the provider lock and only advance still-pending rows so a
    // concurrent revoke cannot be overwritten back to pending/connected.
    let busy = false;
    const applied = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(context.actor, input.connectorId, input.provider),
      async (tx) => {
        await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
        const updated = await tx.connection.updateMany({
          where: {
            id: row.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            status: "pending",
          },
          data: {
            status: auth.authorizationUrl ? "pending" : "connected",
            providerRef: auth.state || null,
            metadata: { state: auth.state },
          },
        });
        return updated.count > 0;
      },
    ).catch((error: unknown) => {
      if (!(error instanceof ProviderTransactionBusyError)) throw error;
      busy = true;
      return false;
    });
    if (applied && !auth.authorizationUrl) {
      await recordSecurityEvent(connectionCreatedEvent("connections.begin", row.id, context.actor));
    }
    if (!applied) {
      // Revoke won the race, or the result could not be saved in time. Clean up the
      // remote authorization without a provider-wide slug delete.
      const state = auth.state?.trim();
      const adapterContext = connectionContext(context.actor, "connections.begin", context.signal);
      if (state && state !== input.provider) {
        // A provider whose browser OAuth stores an authorization-request id in auth.state.
        // Cancel that request by id so the authorization URL cannot later create an
        // untracked remote; resolve an ACTIVE account id only when cancel is unavailable.
        if (connector.cancelAuthorizationRequest) {
          await connector.cancelAuthorizationRequest(state, adapterContext).catch(() => undefined);
        } else {
          const revokeRef = connector.resolveConnectedAccountId
            ? await connector
                .resolveConnectedAccountId(
                  context.actor.userId,
                  input.provider,
                  state,
                  [],
                  context.actor.spaceId,
                )
                .catch(() => undefined)
            : state;
          if (revokeRef) {
            await connector.revoke(revokeRef, adapterContext).catch(() => undefined);
          }
        }
      } else if (state === input.provider) {
        // A provider whose begin only returns the app slug. Drop remotes that no
        // remaining local row still references so a lost race cannot leave
        // an orphan authorization, without wiping sibling accounts.
        if (connector.revokeUnreferencedAccounts) {
          // Hold the provider lock across the keep-id snapshot and remote
          // cleanup so a concurrent complete cannot persist a providerRef
          // that this cleanup then deletes as unreferenced.
          await providerLockTransaction(
            deps.prisma,
            providerScopeKey(context.actor, input.connectorId, input.provider),
            async (tx) => {
              await lockProviderConnectionScope(
                tx,
                context.actor,
                input.connectorId,
                input.provider,
              );
              const kept = await tx.connection.findMany({
                where: {
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  connectorId: input.connectorId,
                  provider: input.provider,
                  status: { in: ["connected", "pending", "error"] },
                },
                select: { providerRef: true },
              });
              const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                kept.map((entry) => entry.providerRef),
                input.provider,
              );
              // Skip while any sibling still lacks a concrete account id —
              // otherwise slug-only pending refs are dropped from keepIds and
              // revokeUnreferencedAccounts deletes that sibling's remote auth.
              if (!canRevokeUnreferenced) return;
              await connector.revokeUnreferencedAccounts?.(input.provider, keepIds, adapterContext);
            },
          ).catch(() => undefined);
        }
      }
      if (busy) throw new ProviderTransactionBusyError();
      throw new IsolationError();
    }
    return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    await deps.prisma.connection.updateMany({
      where: {
        id: row.id,
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
        status: "pending",
      },
      data: { status: "error" },
    });
    if (error instanceof ProviderTransactionBusyError) throw error;
    if (error instanceof ConnectorAuthUnavailableError) {
      getLogger().warn("connections.begin app has no usable auth config", {
        connectorId: input.connectorId,
        provider: input.provider,
        reason: String(error.cause),
      });
      throw new ORPCError(error.code, { status: 400, message: error.message });
    }
    throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
  }
}

export async function completeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string; code?: string },
) {
  const existing = await deps.prisma.connection.findFirst({
    where: {
      id: input.connectionId,
      spaceId: context.actor.spaceId,
      userId: context.actor.userId,
    },
  });
  if (!existing) throw new IsolationError();
  const connector = deps.connectors.managed(existing.connectorId);
  if (!connector) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Connector ${existing.connectorId} is not configured`,
    });
  }
  // Catalog reconciliation connects a row without its account id; the next poll stores it.
  const settling = (row: { status: string; provider: string; providerRef: string | null }) =>
    row.status !== "connected" || row.providerRef === row.provider;
  const prepared = settling(existing)
    ? await prepareManagedConnectorForTransaction(connector)
    : { provider: connector, recheck: undefined };
  const transactionConnector = prepared.provider;
  if (!transactionConnector)
    throw new ORPCError("BAD_REQUEST", { message: "Integration provider is not configured" });
  let row = existing;
  let connectedNow = false;
  if (settling(existing)) {
    // Hold the provider lock across remote completion, account-id resolution,
    // providerRef persistence, and any overlapping revokeUnreferenced cleanup
    // so a concurrent begin-loss cleanup cannot delete the account we are about
    // to persist. Clients poll, so while another call holds the slot or the lock,
    // report the row as it is instead of waiting on a pooled connection.
    row = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(context.actor, existing.connectorId, existing.provider),
      async (tx) => {
        const locked = await tryLockProviderConnectionScope(
          tx,
          context.actor,
          existing.connectorId,
          existing.provider,
        );
        if (!locked) return existing;
        const current = await tx.connection.findFirst({
          where: {
            id: existing.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!current) throw new IsolationError();
        if (prepared.recheck && !(await prepared.recheck(tx))) {
          throw new ORPCError("CONFLICT", {
            message: "Integration credentials changed; retry.",
          });
        }
        if (!settling(current)) return current;
        if (current.status === "revoked") {
          // Authorization URLs from a revoke-win begin can still finish
          // remotely. Cancel leftover authorization-request ids, or drop slug-scoped
          // remotes no active local row still references, before rejecting.
          // Not the request signal: clients abort a poll they no longer need, and
          // that must not cut short removing the leftover remote account.
          const revokedContext = connectionContext(context.actor, "connections.complete");
          const restoreRevokedForRetry = async () => {
            // Cleanup failed while the row is already revoked — restore pending
            // so the UI can retry removal instead of leaving an orphan remote.
            // Use the root client (not tx): throwing below aborts this
            // transaction and would otherwise roll back a tx-scoped restore.
            await deps.prisma.connection.updateMany({
              where: {
                id: current.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "revoked",
              },
              data: { status: "pending" },
            });
          };
          const pendingRef = current.providerRef?.trim();
          try {
            if (pendingRef && pendingRef !== current.provider) {
              if (transactionConnector.cancelAuthorizationRequest) {
                await transactionConnector.cancelAuthorizationRequest(pendingRef, revokedContext);
              } else {
                const revokeRef = transactionConnector.resolveConnectedAccountId
                  ? await transactionConnector
                      .resolveConnectedAccountId(
                        context.actor.userId,
                        current.provider,
                        pendingRef,
                        [],
                        context.actor.spaceId,
                      )
                      .catch(() => undefined)
                  : pendingRef;
                if (revokeRef) {
                  await transactionConnector.revoke(revokeRef, revokedContext);
                }
              }
            } else {
              if (transactionConnector.revokeUnreferencedAccounts) {
                const kept = await tx.connection.findMany({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    status: { in: ["connected", "pending", "error"] },
                  },
                  select: { providerRef: true },
                });
                const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                  kept.map((entry) => entry.providerRef),
                  existing.provider,
                );
                if (canRevokeUnreferenced) {
                  await transactionConnector.revokeUnreferencedAccounts(
                    existing.provider,
                    keepIds,
                    revokedContext,
                  );
                }
              }
            }
          } catch (error) {
            getLogger().error("connections.complete remote cleanup failed for revoked row", error, {
              connectionId: current.id,
              connectorId: existing.connectorId,
              provider: existing.provider,
            });
            await restoreRevokedForRetry();
            // Still superseded: stop the poll so it cannot complete the restored row,
            // which stays pending in the account list for removal.
            throw new IsolationError();
          }
          // A newer attempt or a removal superseded this one. Report it so the
          // caller stops polling instead of retrying an error.
          return current;
        }

        const adapterContext = connectionContext(
          context.actor,
          "connections.complete",
          context.signal,
        );
        if (input.code && current.status !== "connected") {
          const state = current.providerRef ?? current.provider;
          try {
            await transactionConnector.complete({ state, code: input.code }, adapterContext);
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
          }
        }
        const ready = await transactionConnector.connectionReady(adapterContext, current.provider);
        if (!ready) return current;

        // Browser OAuth stores a connection-request id in providerRef from
        // begin. Resolve it to the connected-account id so revoke deletes the
        // right remote authorization. Prefer an account id not already used
        // by a sibling row for the same provider.
        const resolveAccountId = (ref: string | null | undefined, excludeIds: string[]) =>
          transactionConnector
            .resolveConnectedAccountId?.(
              context.actor.userId,
              existing.provider,
              ref,
              excludeIds,
              context.actor.spaceId,
            )
            .catch(() => undefined);
        let resolvedAccountId: string | undefined;
        if (transactionConnector.resolveConnectedAccountId) {
          const siblings = await tx.connection.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: existing.connectorId,
              provider: existing.provider,
              id: { not: existing.id },
              status: { in: ["connected", "pending", "error"] },
            },
            select: { providerRef: true, status: true },
          });
          // Exclude concrete account ids only. A pending sibling may still
          // store a slug or authorization-request id; passing those raw refs
          // would not match remote account ids and can let this row adopt the
          // sibling's account. If a sibling ref cannot be resolved yet, leave
          // this row pending so a later complete can re-resolve safely.
          const excludeIds: string[] = [];
          for (const sibling of siblings) {
            const ref = sibling.providerRef?.trim();
            // Slug-only refs cannot identify a concrete remote account; resolving
            // them would pick an arbitrary ACTIVE id and over-exclude.
            if (!ref || ref === existing.provider) {
              // A connected row has no claim on a newer account a sibling may have just authorized.
              if (current.status === "connected" && sibling.status === "pending") return current;
              continue;
            }
            const resolvedSiblingId = await resolveAccountId(ref, []);
            if (!resolvedSiblingId) return current;
            excludeIds.push(resolvedSiblingId);
          }
          resolvedAccountId = await resolveAccountId(current.providerRef, excludeIds);
        }

        // When a resolver exists and providerRef is still a request-scoped
        // id (not the provider slug), require a concrete account id before
        // marking connected — otherwise revoke would delete the wrong ref.
        if (
          transactionConnector.resolveConnectedAccountId &&
          current.providerRef &&
          current.providerRef !== current.provider &&
          !resolvedAccountId
        ) {
          return current;
        }

        const providerRef = resolvedAccountId ?? current.providerRef;
        if (providerRef) {
          const taken = await tx.connection.findFirst({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: existing.connectorId,
              provider: existing.provider,
              id: { not: existing.id },
              status: { in: ["connected", "pending", "error"] },
              providerRef,
            },
            select: { id: true },
          });
          if (taken) {
            // Do not mark connected with a request-scoped or shared ref —
            // leave pending so a later complete can re-resolve an unused id.
            return current;
          }
        }
        // Catalog reconciliation does not take the provider lock, so it may have
        // connected this row meanwhile; only the call that changes it records the event.
        const updated = await tx.connection.updateMany({
          where: { id: current.id, status: current.status },
          data: {
            status: "connected",
            ...(providerRef ? { providerRef } : {}),
          },
        });
        connectedNow = updated.count > 0 && current.status !== "connected";
        if (!connectedNow && providerRef) {
          // Reconciliation sets only the status; keep the resolved account id so
          // revoke still deletes the right remote account.
          await tx.connection.updateMany({
            where: { id: current.id, status: "connected" },
            data: { providerRef },
          });
        }
        const next = await tx.connection.findFirst({
          where: {
            id: current.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!next) throw new IsolationError();
        return next;
      },
      COMPLETE_POLL_SLOT_WAIT_MS,
    ).catch((error: unknown) => {
      if (error instanceof ProviderTransactionBusyError) return existing;
      throw error;
    });
  }
  // Clients poll this procedure, so it records the credential once, on the transition.
  if (connectedNow) {
    await recordSecurityEvent(
      connectionCreatedEvent("connections.complete", row.id, context.actor),
    );
  }
  return {
    id: row.id,
    connectorId: row.connectorId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status as "pending" | "connected" | "revoked" | "error",
    capabilities: [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function revokeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string },
) {
  type RemoteRevoke = {
    connectorId: string;
    connectionRef: string;
    accountSpecific: boolean;
  };
  const snapshot = await deps.prisma.connection.findFirst({
    where: {
      id: input.connectionId,
      spaceId: context.actor.spaceId,
      userId: context.actor.userId,
    },
  });
  const needsProvider =
    snapshot &&
    ["connected", "pending", "error"].includes(snapshot.status) &&
    (!snapshot.providerRef || snapshot.providerRef === snapshot.provider) &&
    (await deps.prisma.connection.count({
      where: {
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
        connectorId: snapshot.connectorId,
        provider: snapshot.provider,
        id: { not: snapshot.id },
        status: { in: ["connected", "pending"] },
      },
    })) === 0;
  const configured = needsProvider ? deps.connectors.managed(snapshot.connectorId) : undefined;
  const prepared = configured ? await prepareManagedConnectorForTransaction(configured) : undefined;
  const outcome = await providerLockTransaction(
    deps.prisma,
    // The pre-transaction snapshot owns the scope; the row's connector and provider
    // never change, and without it (row already gone) the transaction is a quick read.
    snapshot
      ? providerScopeKey(context.actor, snapshot.connectorId, snapshot.provider)
      : `connection:${input.connectionId}`,
    async (tx) => {
      const row = await tx.connection.findFirst({
        where: {
          id: input.connectionId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        },
      });
      if (!row) {
        return {
          remote: null as null | RemoteRevoke,
          previousStatus: null as string | null,
        };
      }

      // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
      // alone misses a concurrent begin that inserts after the lock query.
      await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
      await tx.$queryRaw`
        SELECT id
        FROM connections
        WHERE "spaceId" = ${context.actor.spaceId}
          AND "userId" = ${context.actor.userId}
          AND "connectorId" = ${row.connectorId}
          AND provider = ${row.provider}
          AND status IN ('connected', 'pending', 'error')
        FOR UPDATE`;

      const updated = await tx.connection.updateMany({
        where: {
          id: row.id,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          status: { in: ["connected", "pending", "error"] },
        },
        data: { status: "revoked" },
      });
      if (updated.count === 0) {
        return {
          remote: null as null | RemoteRevoke,
          previousStatus: null as string | null,
        };
      }

      const remaining = await tx.connection.count({
        where: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: row.connectorId,
          provider: row.provider,
          status: { in: ["connected", "pending"] },
        },
      });
      const connectionRef = row.providerRef || row.provider;
      const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
      // Account-scoped refs can disconnect one remote authorization while
      // siblings remain. Slug-only legacy rows must wait until they are last,
      // or a provider-wide revoke would drop every account for that app.
      if (!accountSpecific && remaining > 0) {
        return {
          remote: null as null | RemoteRevoke,
          previousStatus: null as string | null,
        };
      }

      // Slug-only remote delete is provider-wide. Run it before commit while
      // still holding the begin/revoke lock so a new authorization cannot be
      // created and then wiped by a provider's slug-scoped DELETE.
      if (!accountSpecific) {
        if (
          !needsProvider ||
          row.connectorId !== snapshot?.connectorId ||
          row.provider !== snapshot?.provider ||
          (prepared?.recheck && !(await prepared.recheck(tx)))
        ) {
          throw new ORPCError("CONFLICT", {
            message: "Integration credentials changed; retry.",
          });
        }
        const connector = prepared?.provider;
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${row.connectorId} is not configured`,
          });
        }
        try {
          // Abort before the 60s Prisma transaction timeout so a late remote
          // delete cannot succeed after local status has already rolled back.
          const signals = [AbortSignal.timeout(45_000)];
          if (context.signal) signals.unshift(context.signal);
          const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
          await connector.revoke(
            connectionRef,
            connectionContext(context.actor, "connections.revoke", revokeSignal),
          );
        } catch (error) {
          if (error instanceof ORPCError) throw error;
          throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
        }
        return {
          remote: null as null | RemoteRevoke,
          previousStatus: null as string | null,
        };
      }

      return {
        remote: {
          connectorId: row.connectorId,
          connectionRef,
          accountSpecific,
        },
        previousStatus: row.status,
      };
    },
  );

  if (outcome.remote) {
    const restoreLocalStatus = async () => {
      // Local row was marked revoked inside the transaction; restore it so a
      // failed remote disconnect remains retryable instead of orphaned.
      if (!outcome.previousStatus) return;
      await deps.prisma.connection.updateMany({
        where: {
          id: input.connectionId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          status: "revoked",
        },
        data: { status: outcome.previousStatus },
      });
    };
    try {
      const connector = deps.connectors.managed(outcome.remote.connectorId);
      if (!connector) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Connector ${outcome.remote.connectorId} is not configured`,
        });
      }
      await connector.revoke(
        outcome.remote.connectionRef,
        connectionContext(context.actor, "connections.revoke", context.signal),
      );
    } catch (error) {
      // Restore when DELETE clearly did not run (including pre-delete list
      // timeouts). Post-delete timeouts stay ambiguous — leave revoked.
      if (shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
        await restoreLocalStatus();
      } else {
        const where = {
          connectionId: input.connectionId,
          connectorId: outcome.remote.connectorId,
        };
        const message = "connections.revoke remote outcome uncertain; leaving local revoked";
        // The caller hung up mid-revoke: the row is already handled, nothing to report.
        if (context.signal?.aborted) getLogger().warn(message, where);
        else getLogger().error(message, error, where);
      }
      if (error instanceof ORPCError) throw error;
      throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
    }
  }
  return { ok: true as const };
}

import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  computerControlExpireJobKey,
  SandboxAllowanceUsedError,
  SandboxRateLimitError,
  SandboxSizeUnavailableError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { ComputerSize, ComputerUpdate } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  abortableDelay,
  COMPUTER_USING_RUNS,
  isRetryableError,
  parseScreenLeaseId,
  screenLeaseId,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  expireComputerExecutionLeases,
  isUniqueViolation,
  parseComputerMode,
  planComputerSize,
  recordComputerRunEnd,
  recordComputerRunStart,
  spaceTakesWork,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  clearInactiveUserComputerControl,
  endTeachingWithLease,
  expireComputerControl,
  hasActiveComputerControl,
  holdsUserControl,
  revokeScreenControl,
} from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import {
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  mountsServerHome,
  removeDeletedBotWorkspaces,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { resolveAgentHomePath } from "./home.js";
import { ObjectAgentHomeStore } from "./home-object-store.js";
import { sandboxAllowanceUsedUp } from "./sandbox-allowance.js";
import {
  isSandboxDamagedError,
  isSandboxGoneError,
  isSandboxUnsafeStopError,
} from "./sandbox-errors.js";

type ComputerUpdateProgress = (
  stage: Exclude<ComputerUpdate["stage"], "preparing">,
) => Promise<void>;

export const EXECUTION_LEASE_MS = 5 * 60_000;
const BOOT_WAIT_ATTEMPTS = 40;
const BOOT_WAIT_MS = 250;
const RUNNING_CHECK_RETRY_MS = [250, 750];
/**
 * Dedicated / lease-less boots never write an execution-lease row, so this stamp age is the
 * lower bound before reclaim/Reset may treat a lease-less claim as abandoned. Slow dedicated
 * boots past this window stay protected while their run worker lease still heartbeats.
 */
const BOOT_CLAIM_STALE_MS = EXECUTION_LEASE_MS;

/**
 * Booting and suspending claims newer than an execution-lease TTL are live.
 * Older ones are abandoned: the worker died mid-transition, and Reset or a later
 * provision may reclaim them. Missing stamps fail closed (treated as live).
 */
function isAbandonedLifecycleClaim(updatedAt: Date | null | undefined, now = Date.now()): boolean {
  return updatedAt instanceof Date && now - updatedAt.getTime() >= BOOT_CLAIM_STALE_MS;
}

function isLiveSuspending(
  computer: { state: string; updatedAt?: Date | null },
  now = Date.now(),
): boolean {
  return computer.state === "suspending" && !isAbandonedLifecycleClaim(computer.updatedAt, now);
}

/**
 * "Nobody but us holds this computer."
 *
 * Whoever moves a computer to "booting" holds its execution lease for the whole provision,
 * renewed on the run heartbeat, so a booting row whose only live lease is our own belongs to
 * a worker that died between the claim and its own failure handler. Without reclaiming it the
 * computer stays wedged and every run on its bot retries forever.
 *
 * Used only when claiming an abandoned "booting" row. End-of-boot writes fence on the claim
 * stamp (updatedAt) instead: fencing them with this predicate too would let a second Team bot
 * lease that appears mid-provision block both activation and the failure write, leave the row
 * stuck in "booting", and destroy the valid winner's sandbox. A lease that merely expired
 * without being taken still passes, so a slow manual boot that never heartbeats keeps working.
 *
 * When screenLeaseId is absent, require that no live execution lease exists at all. Booting
 * reclaim compare-and-swaps the pre-wait updatedAt so two lease-less callers cannot both
 * match even if one re-reads the other's claim stamp during the boot wait.
 */
function heldByNobodyElse(lease: { ownerId: string; fence: number } | null) {
  return {
    executionLeases: {
      none: {
        expiresAt: { gt: new Date() },
        ...(lease ? { NOT: { runId: lease.ownerId, fence: lease.fence } } : {}),
      },
    },
  };
}

/**
 * A live execution lease held by some OTHER bot on this computer.
 *
 * replaceComputer already holds the lease for its own bot, so "any live lease" would always
 * be true there; a shared Team Computer mid-boot for a different bot must still be refused.
 */
async function hasForeignExecutionLease(
  prisma: PrismaClient,
  computerId: string,
  botId: string,
): Promise<boolean> {
  const live = await prisma.computerExecutionLease.findFirst({
    where: { computerId, botId: { not: botId }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return live !== null;
}

/**
 * A live worker lease on another run that uses this computer.
 *
 * Dedicated boots never take a computer execution lease, so after BOOT_CLAIM_STALE_MS the
 * claim stamp alone would look abandoned while provision is still running. A heartbeating
 * run lease proves the provisioner is alive. exceptRunId lets a recovering continueRun
 * reclaim its own abandoned boot without treating itself as foreign.
 */
async function hasLiveForeignRunLease(
  prisma: PrismaClient,
  computerId: string,
  exceptRunId?: string,
): Promise<boolean> {
  const live = await prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { computerId },
      ...COMPUTER_USING_RUNS,
      leaseExpiresAt: { gt: new Date() },
      ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
    },
    select: { id: true },
  });
  return live !== null;
}

export class ComputerBusyError extends Error {
  constructor() {
    super("Computer is busy");
    this.name = "ComputerBusyError";
  }
}

/** A stop was not confirmed, so this computer must remain isolated until recovery. */
export class ComputerRecoveryRequiredError extends Error {
  constructor() {
    super(
      "Computer requires recovery after an unconfirmed stop. Recover the computer to rebuild it.",
    );
    this.name = "ComputerRecoveryRequiredError";
  }
}

/** The computer's Space is being deleted, so it takes no maintenance until that ends. */
export class ComputerSpaceDeletingError extends ComputerBusyError {}

export { toComputerRef } from "./computer-support.js";

/**
 * The owner's time zone and app language for the computer's clock and browser, so pages see the
 * account's instead of the server's. Unknown, or unreadable, leaves the provider's defaults: a
 * computer still starts without them.
 */
async function computerOwnerLocale(
  prisma: PrismaClient,
  userId: string,
): Promise<{ timezone?: string; language?: string }> {
  try {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true, locale: true },
    });
    return {
      ...(owner?.timezone ? { timezone: owner.timezone } : {}),
      ...(owner?.locale ? { language: owner.locale } : {}),
    };
  } catch (error) {
    getLogger().warn("computer.owner_locale_unavailable", { error });
    return {};
  }
}

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  const started = performance.now();
  const log = getLogger().child({ "computer.id": computerId, "run.id": context.runId });
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  // A refusal reaches the bot only as "Computer is busy", so the cause is logged here.
  const busy = (reason: string) => {
    log.warn("computer.busy", {
      reason,
      // As last read; a refused conditional claim means the row has since changed.
      "computer.observed_state": existing.state,
      "bot.id": context.botId,
      durationMs: Math.round(performance.now() - started),
    });
    return new ComputerBusyError();
  };
  if (existing.state === "quarantined") throw new ComputerRecoveryRequiredError();
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw busy("maintenance");
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");

  // Re-provisioning a live computer enters booting and revokes its screen URLs.
  // A provider-confirmed live reference needs setup, not a new lifecycle claim.
  if (
    existing.state === "running" &&
    existing.providerRef &&
    !existing.restorePending &&
    deps.sandbox.isRunning
  ) {
    const ref = toComputerRef(existing);
    if (await confirmedRunning(deps.sandbox, ref, context)) {
      context.signal.throwIfAborted();
      const runningSince = existing.runningSince ?? new Date();
      const retained = await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "running",
          providerRef: existing.providerRef,
          kind: existing.kind,
          screenGeneration: existing.screenGeneration,
          maintenanceId: existing.maintenanceId ?? null,
          ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
        },
        // A row activated by an older release has no clock yet; start it now.
        data: { updatedAt: new Date(), runningSince },
      });
      if (retained.count !== 1) throw busy("running_claim_lost");
      await recordComputerRunStart(deps.prisma, existing, runningSince);
      const damaged = await deps.sandbox.prepare(ref, context).then(
        () => false,
        (error: unknown) => {
          // Only the reconnect claim below can stop a damaged system back to its last good copy.
          if (!isSandboxDamagedError(error)) throw error;
          return true;
        },
      );
      if (!damaged) {
        await ensureComputerWorkspaceLayout(
          deps.sandbox,
          ref,
          parseComputerMode(existing.scope),
          context.botId,
          context,
        );
        log.info("computer.provisioned", {
          provider: ref.kind,
          operation: "reuse",
          durationMs: Math.round(performance.now() - started),
        });
        return ref;
      }
      context.signal.throwIfAborted();
    }
  }

  // A computer that bills starts only while its organization has allowance left this period.
  const startKind = (await deps.sandbox.provisionKind?.(existing.homeKey)) ?? existing.kind;
  if (await sandboxAllowanceUsedUp(deps, { spaceId: existing.spaceId, kind: startKind }))
    throw new SandboxAllowanceUsedError();
  const size = await planComputerSize(deps.prisma, existing.spaceId);

  // If we first observe abandoned "booting", remember that stamp before waiting. A concurrent
  // reclaim bumps updatedAt while state stays "booting"; fencing the claim on the pre-wait
  // stamp keeps those callers mutually exclusive. After the wait, a finished boot returns
  // "running" and takes the normal reconnect claim instead.
  //
  // Only reclaim stamps that were already older than an execution-lease TTL when we first
  // saw them. A fresher stamp means another caller may still be provisioning (dedicated and
  // lease-less boots can outlast the short boot-wait poll); stealing would double-provision
  // and roll back their sandbox. Live team boots with an execution lease are already blocked
  // by heldByNobodyElse; this guards the lease-less path (and expired-lease gaps).
  const reclaimStamp = existing.state === "booting" ? existing.updatedAt : null;
  const bootClaimIsStale =
    reclaimStamp !== null && Date.now() - reclaimStamp.getTime() >= BOOT_CLAIM_STALE_MS;
  // Idle stop does not refresh updatedAt while checkpointing or waiting on provider stop.
  // A live suspend can therefore age across the TTL during the ready wait; only reclaim
  // stamps that were already abandoned when we first saw them, matching booting reclaim.
  const suspendStamp = existing.state === "suspending" ? existing.updatedAt : null;
  const suspendClaimIsStale = suspendStamp !== null && isAbandonedLifecycleClaim(suspendStamp);
  // A fresh booting claim (or one whose run lease is still live) cannot be reclaimed after
  // the wait either, so do not block workers for the full boot-wait window.
  if (existing.state === "booting" && reclaimStamp !== null && !bootClaimIsStale) {
    throw busy("boot_in_progress");
  }
  if (
    existing.state === "booting" &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw busy("boot_by_live_run");
  }
  if (existing.state === "booting" || existing.state === "suspending") {
    existing = await waitForComputerReady(deps.prisma, computerId, context);
  }
  // A booting row whose holder is gone is reclaimable. A suspending row is too once
  // its claim was already older than an execution-lease TTL when first observed and
  // no other run is still alive.
  const staleSuspending =
    existing.state === "suspending" &&
    suspendClaimIsStale &&
    !(await hasLiveForeignRunLease(deps.prisma, computerId, context.runId));
  if (
    !staleSuspending &&
    !["running", "stopped", "suspended", "error", "booting"].includes(existing.state)
  ) {
    throw busy("not_ready");
  }
  // Waited for suspending (or similar) and landed on booting we never stamped: another
  // caller owns that boot. Do not adopt its updatedAt / previousRef and double-provision.
  if (existing.state === "booting" && reclaimStamp === null) {
    throw busy("boot_by_other");
  }
  // We came to reclaim abandoned booting; if another caller already activated, do not fall
  // through into reconnect (that would provision again under their providerRef).
  if (reclaimStamp !== null && existing.state === "running") {
    throw busy("started_by_other");
  }
  // Stamp age is only a lower bound. Dedicated / lease-less boots can provision longer than
  // BOOT_CLAIM_STALE_MS; a heartbeating foreign run lease means the holder is still alive.
  if (
    existing.state === "booting" &&
    reclaimStamp !== null &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw busy("reclaim_blocked_by_live_run");
  }

  const reconnecting =
    Boolean(existing.providerRef) &&
    (existing.state === "running" || existing.state === "suspending");
  // Reconnect can allocate a replacement too. Claim it before any provider call,
  // and compare the observed reference so a delayed caller cannot replace a winner.
  // An abandoned "booting" row is claimed only when no other live execution lease remains,
  // and only when we observed "booting" (never as an OR arm on a running/stopped claim).
  const previousRef = { providerRef: existing.providerRef, kind: existing.kind };
  const bootLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
  // Reclaim "booting" only when we observed it. Always ORing a booting arm lets a second
  // caller match after the first claimed running/stopped/… → booting and double-provision.
  // Stale "suspending" uses the same stamp fence so two recoveries cannot both provision.
  const claimWhere =
    existing.state === "booting" || existing.state === "suspending"
      ? {
          state: existing.state,
          updatedAt: existing.state === "booting" ? reclaimStamp! : suspendStamp!,
          ...(existing.state === "suspending" ? previousRef : {}),
          ...heldByNobodyElse(bootLease),
        }
      : {
          state: existing.state,
          ...previousRef,
        };
  // Choose the claim stamp before writing so a concurrent reclaim cannot make us adopt its
  // updatedAt on a follow-up read (which would let our activation overwrite the newer owner).
  // Advance past the observed stamp even when Date.now() equals it (same ms or clock skew);
  // otherwise a booting self-transition would leave the CAS token unchanged and a second
  // worker that observed the same stamp could also claim and provision.
  const observedStamp = reclaimStamp ?? suspendStamp ?? existing.updatedAt;
  const claimStamp = new Date(Math.max(Date.now(), observedStamp.getTime() + 1));
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      ...claimWhere,
      // A start this one reclaims from may have marked its new machine since it was read.
      restorePending: existing.restorePending,
      maintenanceId: existing.maintenanceId ?? null,
      ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
    },
    data: { state: "booting", updatedAt: claimStamp },
  });
  if (claimed.count !== 1) throw busy("claim_lost");
  let provisioned: ComputerRef | undefined;
  let incomplete = false;
  // A start that took over an abandoned boot cannot tell how far that boot restored, so it restores.
  const replaces = (ref: ComputerRef) =>
    reclaimStamp !== null ||
    existing.restorePending ||
    ref.fresh === true ||
    !existing.providerRef ||
    existing.providerRef !== ref.providerRef ||
    existing.kind !== ref.kind;
  try {
    // A computer that mounts the server's home boots on the object store's cached copy, so that
    // copy must hold the stored revision before provision. The kind is the one provision will
    // produce; any other computer downloads the revision only if a replacement restores it below.
    // Only a Docker computer's own reconnect may find its live copy there.
    const cache = deps.home instanceof ObjectAgentHomeStore ? deps.home : undefined;
    // Once this start holds the claim and before anything recreates the folder, so a deleted
    // cache comes back downloaded, never as an empty folder taken for the stored revision.
    await cache?.forgetMissingCache(existing.homeKey);
    const hydrated =
      cache !== undefined &&
      mountsServerHome(
        (await deps.sandbox.provisionKind?.(existing.homeKey)) ?? deps.sandbox.describe().id,
      );
    if (hydrated)
      await cache.hydrate(existing.homeKey, {
        keepLiveCache: reconnecting && existing.kind === "docker",
      });
    await mkdir(homePath, { recursive: true });
    await onProgress?.("recreating");
    const owner = await computerOwnerLocale(deps.prisma, existing.userId);
    const provisionAt = (startSize: ComputerSize | undefined) =>
      getLogger().withContext(
        { "computer.id": computerId, "run.id": context.runId, previousState: existing.state },
        () =>
          deps.sandbox.provision(
            {
              botId: existing.homeKey,
              homePath,
              providerRef: existing.providerRef ?? undefined,
              providerKind: existing.kind as ComputerRef["kind"],
              // A save from an older release has no time; the provider keeps its own state then.
              savedAt:
                existing.homeRevision === "empty"
                  ? undefined
                  : (existing.homeRevisionAt ?? undefined),
              size: startSize,
              ...owner,
            },
            context,
          ),
      );
    // A provider that cannot move the computer to the plan's size starts it at the size it has.
    const provision = async () => {
      try {
        return await provisionAt(size);
      } catch (error) {
        if (!(error instanceof SandboxSizeUnavailableError)) throw error;
        log.warn("computer.size_unavailable", { size, reason: error.reason });
        return provisionAt(undefined);
      }
    };
    // A new machine under the stored name, or any machine of a reclaimed boot, is incomplete until
    // restored. Mark it as soon as the provider returns it, so a start that fails or dies after that
    // point leaves the row marked; a failed start records the mark even if this write did not land.
    const markReplacement = async (next: ComputerRef) => {
      if (
        reclaimStamp === null &&
        (next.fresh !== true ||
          next.providerRef !== existing.providerRef ||
          next.kind !== existing.kind)
      )
        return;
      incomplete = true;
      const claim = await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "booting",
          updatedAt: claimStamp,
          ...previousRef,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: { restorePending: true, updatedAt: claimStamp },
      });
      if (claim.count !== 1) throw busy("restore_claim_lost");
    };
    let ref = await provision();
    provisioned = ref;
    await markReplacement(ref);
    try {
      await deps.sandbox.prepare(ref, context);
    } catch (error) {
      if (
        !isSandboxDamagedError(error) ||
        !(await claimAutoRecovery(deps.prisma, existing, claimStamp))
      )
        throw error;
      // Stopping keeps the provider's last good copy of a system that can no longer run anything,
      // and starting again resumes it, or replaces it from the saved workspace when that is newer.
      log.warn("computer.auto_recover", { provider: ref.kind, step: "stop", error });
      try {
        // A computer this call just created holds nothing yet; make another rather than leave
        // it behind while starting again would create a second one.
        if (ref.fresh) await deps.sandbox.destroy(ref, context);
        else await deps.sandbox.stop(ref, context, { discardUnsaved: true });
        ref = await provision();
        provisioned = ref;
        await markReplacement(ref);
        await deps.sandbox.prepare(ref, context);
      } catch (failure) {
        log.warn("computer.auto_recover", { provider: ref.kind, step: "failed", error: failure });
        // Recover stays the way out; a failure on the way says less than the damage itself.
        throw isSandboxDamagedError(failure) ? failure : error;
      }
      log.warn("computer.auto_recover", {
        provider: ref.kind,
        step: "recovered",
        operation: ref.fresh ? "replaced" : "resumed",
      });
    }
    // Provision chooses its kind again, so a host change since the check above can mount a cache
    // that was not brought up to date. Failing rolls this computer back; the next start downloads.
    if (cache && !hydrated && mountsServerHome(ref.kind))
      throw new Error("Computer host changed while it was starting");
    const replacement = replaces(ref);
    if (replacement) {
      await onProgress?.("restoring");
      await restoreComputerWorkspace(deps.home, deps.sandbox, existing.homeKey, ref, context);
    }
    await onProgress?.("reconnecting");
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      context,
    );
    // Bots deleted while this computer was not running could not remove their folders then.
    // Skip only plain reconnects; a provider may start or replace the computer during one.
    if (existing.scope === "team" && (!reconnecting || replacement || ref.started === true)) {
      await removeDeletedBotWorkspaces(deps, ref, existing.spaceId, context).catch((error) => {
        // The run's cancellation cut it short; the next boot retries the cleanup.
        if (context.signal.aborted && isCancellation(error, context.signal)) return;
        getLogger().error("team bot folder cleanup", error);
      });
    }
    const activeControl = hasActiveComputerControl(existing);
    // A reconnect to a computer that stayed up continues its stretch; any start begins one.
    const continued =
      existing.state === "running" && existing.runningSince && !ref.started && !replacement;
    const runningSince = continued ? existing.runningSince! : new Date();
    const activated = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "booting",
        updatedAt: claimStamp,
        ...previousRef,
        maintenanceId: existing.maintenanceId ?? null,
        ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
      },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
        restorePending: false,
        runningSince,
        ...(!reconnecting
          ? {
              controlHolder: activeControl ? "user" : controlHolder,
              ...(!activeControl
                ? {
                    controlLeaseId: null,
                    controlUserId: null,
                    controlLeaseExpiresAt: null,
                    controlBotId: null,
                  }
                : {}),
            }
          : {}),
      },
    });
    if (activated.count !== 1) {
      throw busy("activation_lost");
    }
    // A start clears a lapsed lease it found; the recording made under it ends with it.
    if (!reconnecting && !activeControl) {
      await endTeachingWithLease(deps, existing.spaceId, existing.controlLeaseId);
    }
    // A computer we believed running that the provider had to resume or replace was stopped
    // or lost at the provider without us.
    await recordComputerRunStart(
      deps.prisma,
      { ...existing, kind: ref.kind, providerRef: ref.providerRef },
      runningSince,
      existing.state === "running" ? "gone" : "reconciled",
    );
    log.info("computer.provisioned", {
      provider: ref.kind,
      operation: replacement ? "create" : ref.started ? "resume" : "reuse",
      durationMs: Math.round(performance.now() - started),
    });
    return ref;
  } catch (error) {
    log.warn("computer.provision_failed", {
      provider: existing.kind,
      durationMs: Math.round(performance.now() - started),
      error,
    });
    // A failed reconnect never owns an existing workspace, even if setup failed.
    const rollbackError =
      provisioned && (!reconnecting || provisioned.fresh === true)
        ? await rollbackProvisionedComputer(deps.sandbox, provisioned, context, error)
        : undefined;
    const unsafeStop = isSandboxUnsafeStopError(error) || isSandboxUnsafeStopError(rollbackError);
    try {
      await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "booting",
          updatedAt: claimStamp,
          ...previousRef,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: {
          state:
            (reconnecting || rollbackError) && unsafeStop
              ? "quarantined"
              : reconnecting && !existing.restorePending && !incomplete
                ? "running"
                : "error",
          ...((!reconnecting || (unsafeStop && provisioned?.fresh === true)) &&
          rollbackError &&
          provisioned
            ? {
                providerRef: provisioned.providerRef,
                kind: provisioned.kind,
                restorePending: replaces(provisioned),
              }
            : {}),
          ...(incomplete ? { restorePending: true } : {}),
        },
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), recordError],
        "Computer provisioning failed and its failure could not be recorded",
      );
    }
    if (rollbackError) {
      // The provider was still down for the cleanup, which adds nothing to why the start failed.
      if (
        rollbackError instanceof SandboxUnresponsiveError ||
        rollbackError instanceof SandboxUnavailableError ||
        rollbackError instanceof SandboxRateLimitError
      ) {
        log.warn("computer.rollback_failed", { provider: provisioned?.kind, error: rollbackError });
        throw error;
      }
      throw new AggregateError(
        [error, rollbackError],
        "Computer provisioning failed and its sandbox could not be rolled back",
      );
    }
    throw error;
  }
}

/**
 * Whether the provider confirms this reference is running. A status it still cannot read after
 * short retries is not a confirmation, so the caller reconnects as it did before the check.
 */
async function confirmedRunning(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  context: AdapterContext,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const running = (await sandbox.isRunning?.(ref, context)) === true;
      // Some status reads ignore the signal and answer after the run was cancelled.
      context.signal.throwIfAborted();
      return running;
    } catch (error) {
      context.signal.throwIfAborted();
      const wait = RUNNING_CHECK_RETRY_MS[attempt];
      if (wait === undefined || !isRetryableError(error)) {
        getLogger().warn("computer.running_check", { provider: ref.kind, error });
        return false;
      }
      await abortableDelay(wait, context.signal);
    }
  }
}

/**
 * Takes the one automatic recovery a damaged computer gets until a later save shows it works
 * again, so one that comes back damaged is not stopped and started on every use.
 */
async function claimAutoRecovery(
  prisma: PrismaClient,
  computer: { id: string; homeRevisionAt: Date | null; autoRecoveredAt: Date | null },
  claimStamp: Date,
): Promise<boolean> {
  const last = computer.autoRecoveredAt;
  if (last && !(computer.homeRevisionAt && computer.homeRevisionAt > last)) return false;
  const claimed = await prisma.computer.updateMany({
    where: { id: computer.id, state: "booting", updatedAt: claimStamp, autoRecoveredAt: last },
    data: { autoRecoveredAt: new Date(), updatedAt: claimStamp },
  });
  return claimed.count === 1;
}

async function waitForComputerReady(
  prisma: PrismaClient,
  computerId: string,
  context: AdapterContext,
) {
  for (let attempt = 0; attempt < BOOT_WAIT_ATTEMPTS; attempt += 1) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer boot aborted");
    }
    const current = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (current.state === "running" && current.providerRef) return current;
    if (current.state !== "booting" && current.state !== "suspending") return current;
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS));
  }
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
}

async function rollbackProvisionedComputer(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  cause: unknown,
): Promise<unknown | undefined> {
  try {
    await sandbox.releaseScreen?.(computer, context).catch(() => undefined);
    if (computer.fresh) {
      await sandbox.destroy(computer, context);
    } else if (cause instanceof ComputerBusyError) {
      try {
        await sandbox.stop(computer, context);
      } catch {
        await sandbox.destroy(computer, context);
      }
    } else {
      // Nothing on a damaged computer can be read, so only the provider's last good copy is left.
      if (isSandboxDamagedError(cause)) {
        await sandbox.stop(computer, context, { discardUnsaved: true });
      } else {
        await sandbox.stop(computer, context);
      }
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

export interface ComputerExecutionLease {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
}

export function screenLeaseIdForRun(
  lease: Pick<ComputerExecutionLease, "runId" | "fence"> | null,
  runId: string,
  fence = 0,
): string {
  return screenLeaseId(lease?.runId ?? runId, lease?.fence ?? fence);
}

/** Dedicated screen leases serialize workers and retain the fence after release. */
export async function acquireDedicatedScreenLeaseFence(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    workerId: string;
    runFence: number;
  },
): Promise<ComputerExecutionLease> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // Lock in a fixed order and fail fast if assignment or worker ownership is changing.
      const assignedBot = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots
      WHERE id = ${input.botId}
        AND "computerId" = ${input.computerId}
        AND "computerSwitching" = false
      FOR UPDATE SKIP LOCKED`;
      if (assignedBot.length !== 1) throw new ComputerBusyError();

      const computer = await tx.$queryRaw<Array<{ id: string; scope: string }>>`
      SELECT id, scope FROM computers WHERE id = ${input.computerId} FOR UPDATE SKIP LOCKED`;
      if (computer.length !== 1 || computer[0]?.scope !== "dedicated") {
        throw new ComputerBusyError();
      }

      await lockOwnedRun(tx, input);

      // An unexpired holder owns the screen until release, pause, or expiry. Keep the
      // expired row so explicit release never resets the next worker's screen fence.
      // The current worker ownership check also permits resuming this run's held takeover.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
      const [existing] = await tx.computerExecutionLease.updateManyAndReturn({
        where: {
          computerId: input.computerId,
          botId: input.botId,
          OR: [{ expiresAt: { lte: now } }, { runId: input.runId }],
        },
        data: { runId: input.runId, expiresAt, fence: { increment: 1 } },
        select: { fence: true },
      });
      if (existing) {
        return {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence: existing.fence,
        };
      }

      const history = await tx.run.aggregate({
        where: { botId: input.botId },
        _max: { leaseFence: true },
      });
      const fence = Math.max(input.runFence, history._max.leaseFence ?? 0) + 1;
      try {
        const created = await tx.computerExecutionLease.create({
          data: {
            computerId: input.computerId,
            botId: input.botId,
            runId: input.runId,
            fence,
            expiresAt,
          },
          select: { fence: true },
        });
        return {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence: created.fence,
        };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ComputerBusyError();
        throw error;
      }
    }),
  );
}

async function lockOwnedRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; botId: string; workerId: string; runFence: number },
): Promise<void> {
  const currentRun = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM runs
    WHERE id = ${input.runId}
      AND "botId" = ${input.botId}
      AND status = 'running'
      AND "leaseOwner" = ${input.workerId}
      AND "leaseFence" = ${input.runFence}
      AND "leaseExpiresAt" > ${new Date()}
    FOR UPDATE SKIP LOCKED`;
  if (currentRun.length !== 1) throw new ComputerBusyError();
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
  } & ({ workerId: string; runFence: number } | { workerId?: never; runFence?: never }),
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: input.computerId } });
  if (computer.maintenanceId && computer.maintenanceId !== input.runId)
    throw new ComputerBusyError();
  if (computer.scope !== "team") return null;
  if (isLiveSuspending(computer)) throw new ComputerBusyError();
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // Only the locked current worker claim may reclaim a live same-run lease.
      // API operations have no worker claim and may acquire only new or expired leases.
      const ownsRun = input.workerId !== undefined;
      if (ownsRun) await lockOwnedRun(tx, input);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
      const [reclaimed] = await tx.computerExecutionLease.updateManyAndReturn({
        where: {
          computerId: input.computerId,
          botId: input.botId,
          OR: [{ expiresAt: { lt: now } }, ...(ownsRun ? [{ runId: input.runId }] : [])],
        },
        data: {
          runId: input.runId,
          expiresAt,
          fence: { increment: 1 },
        },
        select: { fence: true },
      });
      if (reclaimed) {
        return validateAcquiredComputerLease(tx, {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence: reclaimed.fence,
        });
      }
      try {
        const created = await tx.computerExecutionLease.create({
          data: {
            computerId: input.computerId,
            botId: input.botId,
            runId: input.runId,
            fence: 1,
            expiresAt,
          },
          select: { fence: true },
        });
        return validateAcquiredComputerLease(tx, {
          computerId: input.computerId,
          botId: input.botId,
          runId: input.runId,
          fence: created.fence,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ComputerBusyError();
        throw error;
      }
    }),
  );
}

async function validateAcquiredComputerLease(
  prisma: Prisma.TransactionClient,
  lease: ComputerExecutionLease,
): Promise<ComputerExecutionLease> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: lease.computerId },
    select: { state: true, maintenanceId: true, updatedAt: true },
  });
  if (
    !isLiveSuspending(computer) &&
    (!computer.maintenanceId || computer.maintenanceId === lease.runId)
  )
    return lease;
  throw new ComputerBusyError();
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const renewed = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS) },
  });
  return renewed.count === 1;
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const held = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  // Keep the row as an expired tombstone so the next run for this bot increments
  // its fence. Deleting it resets the fence to 1, which lets a still-open screen
  // session from the previous run reject the new run as stale.
  await expireComputerExecutionLeases(prisma, {
    computerId: lease.computerId,
    botId: lease.botId,
    runId: lease.runId,
    fence: lease.fence,
  });
}

export type ComputerReplaceMode = "recover" | "reset" | "update";

export function computerSupportsUpdate(kind: string): boolean {
  return kind !== "desktop" && kind !== "wuying" && kind !== "none";
}

/** Kinds whose provider opens a user terminal through the shared Linux screen gateway. */
export function computerSupportsTerminal(kind: string): boolean {
  return (
    kind === "docker" ||
    kind === "e2b" ||
    kind === "novita" ||
    kind === "instabox" ||
    kind === "daytona" ||
    kind === "boat" ||
    kind === "kubernetes" ||
    kind === "incus" ||
    kind === "local-vm" ||
    kind === "fake"
  );
}

export async function replaceComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  mode: ComputerReplaceMode,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
  options?: { handBackIdleTakeover?: boolean },
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError();
  const botId = context.botId;
  if (!botId) throw new Error("computer replacement requires a bot id");
  // Only the person holding the screen can hand it back by resetting; another member's
  // session is never claimed out from under them.
  const handBackIdleTakeover =
    options?.handBackIdleTakeover === true &&
    existing.controlHolder === "user" &&
    existing.controlBotId === botId &&
    holdsUserControl(existing, context.userId);
  if (!handBackIdleTakeover && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    const expired = await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    // Failed provider revoke keeps the lease for retry; do not wipe it and continue reset.
    if (!expired && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  // Orphaned controlHolder=user with no lease id can be cleared for reset/recover.
  if (
    !handBackIdleTakeover &&
    existing.controlHolder === "user" &&
    !hasActiveComputerControl(existing) &&
    !existing.controlLeaseId
  ) {
    await clearInactiveUserComputerControl(deps.prisma, existing.id);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlHolder === "user" && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  if (hasActiveComputerControl(existing) && !handBackIdleTakeover) {
    throw new ComputerBusyError();
  }
  // Reset is the in-product recovery for a hung suspend. Recover and update still refuse
  // so they cannot destroy a computer that is only stuck, not requested as a Reset.
  if (existing.state === "suspending" && mode !== "reset") {
    throw new ComputerBusyError();
  }
  // Allow Reset on a stale "booting" or "suspending" row unless another bot still holds a live
  // lease. Dedicated computers never create an execution-lease row, so the foreign-lease check
  // alone cannot see an in-flight dedicated boot or idle stop. Refuse claim stamps younger than
  // an execution-lease TTL (not merely the boot-wait poll) so a slow dedicated provision or
  // suspend is not destroyed mid-flight. Also refuse while a run still uses the computer —
  // before claiming suspending — so rollback cannot bump @updatedAt under an in-flight boot.
  if (existing.state === "booting" || existing.state === "suspending") {
    if (await hasForeignExecutionLease(deps.prisma, computerId, botId)) {
      throw new ComputerBusyError();
    }
    if (!isAbandonedLifecycleClaim(existing.updatedAt)) {
      throw new ComputerBusyError();
    }
    const activeBootRun = await deps.prisma.run.findFirst({
      where: {
        status: { in: [...ACTIVE_RUN_STATUSES] },
        bot: { computerId },
        ...COMPUTER_USING_RUNS,
      },
      select: { id: true },
    });
    if (activeBootRun) throw new ComputerBusyError();
  }

  const previousState = existing.state;
  const previousControl = handBackIdleTakeover
    ? {
        controlHolder: "user" as const,
        controlLeaseId: existing.controlLeaseId,
        controlLeaseExpiresAt: existing.controlLeaseExpiresAt,
        controlBotId: existing.controlBotId,
        controlUserId: existing.controlUserId,
      }
    : null;
  const now = new Date();
  const claimStamp = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1));
  // Nothing is torn down or provisioned in a Space being deleted except by the deletion. Its lock
  // comes before the computer row, so a claim committing meanwhile is seen.
  const claimed = await deps.prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, existing.spaceId))) throw new ComputerSpaceDeletingError();
    return tx.computer.updateMany({
      where: {
        id: computerId,
        state: previousState,
        maintenanceId: existing.maintenanceId ?? null,
        // CAS the booting/suspending stamp so a concurrent live claim cannot be overwritten.
        ...(previousState === "booting" || previousState === "suspending"
          ? { updatedAt: existing.updatedAt }
          : {}),
        executionLeases: { none: { botId: { not: botId }, expiresAt: { gt: now } } },
        ...(handBackIdleTakeover
          ? {
              controlHolder: "user" as const,
              controlBotId: botId,
              controlLeaseId: existing.controlLeaseId,
            }
          : {
              OR: [
                { controlHolder: { not: "user" } },
                { controlLeaseId: null },
                { controlLeaseExpiresAt: null },
                { controlLeaseExpiresAt: { lte: now } },
              ],
            }),
      },
      data: {
        state: "suspending",
        updatedAt: claimStamp,
        ...(handBackIdleTakeover
          ? {
              controlHolder: "none" as const,
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
            }
          : {}),
      },
    });
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  const releaseClaim = () =>
    deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending", updatedAt: claimStamp },
      data: { state: previousState, ...previousControl },
    });
  // Re-check after the claim in case a run started between the pre-check and CAS. Under this
  // operation's maintenance reservation, runs that arrived later wait for it without touching
  // the computer, so only a live lease means one is still using it.
  const inUse =
    existing.maintenanceId === context.operationId
      ? await deps.prisma.computerExecutionLease.findFirst({
          where: { computerId, expiresAt: { gt: new Date() } },
          select: { id: true },
        })
      : await deps.prisma.run.findFirst({
          where: {
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId },
            ...COMPUTER_USING_RUNS,
          },
          select: { id: true },
        });
  if (inUse) {
    await releaseClaim();
    throw new ComputerBusyError();
  }

  if (previousControl?.controlLeaseId && existing.providerRef) {
    try {
      await revokeScreenControl(
        deps,
        existing,
        context,
        previousControl.controlLeaseId,
        // The activation compare still names this providerRef; the replacement
        // overwrites it. Clearing it here would strand the in-flight claim.
        { clearGoneRef: false },
      );
    } catch (error) {
      getLogger().error("release own takeover before maintenance", error);
      await releaseClaim();
      throw new ComputerBusyError();
    }
    await deps.jobs
      .cancel(computerControlExpireJobKey(computerId, previousControl.controlLeaseId))
      .catch((error) => {
        getLogger().error("computer control expiry cancellation", error);
      });
  }
  if (previousControl) {
    // The hand back is final now; a teaching recording made under it ends with it.
    await endTeachingWithLease(deps, existing.spaceId, previousControl.controlLeaseId).catch(
      (error) => getLogger().error("end teaching with maintenance hand back", error),
    );
    try {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: botId },
        select: { thread: { select: { id: true } } },
      });
      if (bot?.thread) {
        await deps.events.append({
          spaceId: context.spaceId,
          threadId: bot.thread.id,
          botId,
          type: "computer.takeover.released",
          payload: {
            holder: "none",
            leaseId: previousControl.controlLeaseId,
            reason: "released",
          },
        });
      }
    } catch (error) {
      getLogger().error("maintenance takeover release event", error);
    }
  }

  const oldRef = existing.providerRef ? toComputerRef(existing) : null;
  // Until teardown starts the old computer is still running, so a failure before then leaves it
  // running, and a later Recover tries to save its work first.
  let tornDown = false;
  try {
    // Retry the checkpoint even after an earlier update left the row in error.
    if (oldRef && (mode === "update" || (existing.state === "running" && mode === "recover"))) {
      // Recover may skip a save that fails while exporting, whether the computer or the staging
      // disk fails it, and a mounted home's save, whose files stay on the server. Once an export
      // is done, failing to store or record it stops Recover instead: the computer still holds
      // the work.
      await onProgress?.("saving");
      const checkpointedAt = new Date();
      let revision: string | undefined;
      let exported = false;
      try {
        revision = await checkpointComputerWorkspace(
          deps.home,
          deps.sandbox,
          existing.homeKey,
          oldRef,
          context,
          {
            prisma: deps.prisma,
            computer: existing,
            onExported: () => {
              exported = true;
            },
          },
        );
      } catch (error) {
        // A gone sandbox has nothing left to checkpoint; the replacement restores
        // the last recorded revision instead of failing the whole replacement.
        if (exported || (!isSandboxGoneError(error) && mode !== "recover")) throw error;
      }
      if (revision !== undefined) {
        const recorded = await deps.prisma.computer.updateMany({
          where: { id: computerId, state: "suspending", updatedAt: claimStamp },
          data: { homeRevision: revision, homeRevisionAt: checkpointedAt, updatedAt: claimStamp },
        });
        if (recorded.count !== 1) throw new ComputerBusyError();
      }
    }
    await onProgress?.("recreating");
    tornDown = true;
    if (oldRef) {
      await deps.sandbox.releaseScreen?.(oldRef, context).catch(() => undefined);
      try {
        await deps.sandbox.destroy(oldRef, context);
      } catch (error) {
        // Recover too: dropping the reference would orphan a sandbox that may still run.
        if (!isSandboxGoneError(error)) throw error;
      }
    }
    const stopped = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "suspending",
        updatedAt: claimStamp,
        maintenanceId: existing.maintenanceId ?? null,
      },
      data: {
        state: "stopped",
        providerRef: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        // The replacement is a new machine; damage to the old one is no reason to hold it back.
        autoRecoveredAt: null,
        diskUsedBytes: null,
        diskFreeBytes: null,
        diskDismissedPercent: null,
        updatedAt: claimStamp,
      },
    });
    if (stopped.count !== 1) throw new ComputerBusyError();
    await recordComputerRunEnd(deps.prisma, existing, "replaced");
    await endTeachingWithLease(deps, existing.spaceId, existing.controlLeaseId);
    return provisionComputer(deps, computerId, context, controlHolder, onProgress);
  } catch (error) {
    const failedState =
      previousState === "quarantined"
        ? "quarantined"
        : previousState === "running" && !tornDown
          ? "running"
          : "error";
    await deps.prisma.computer
      .updateMany({
        where: {
          id: computerId,
          updatedAt: claimStamp,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: { state: failedState },
      })
      .catch(() => undefined);
    throw error;
  }
}

function isCancellation(error: unknown, signal: AbortSignal) {
  return (
    error === signal.reason ||
    (error instanceof Error && (error.name === "AbortError" || error.message === "command aborted"))
  );
}

import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  destroyBot,
  forgetPageShareSecrets,
  removeAgentHome,
  removeDeletedBotsFromLegacyTeamHome,
  toComputerRef,
} from "@rakazo/adapters";
import { anySignal, requestDeadline, withAbort } from "@rakazo/core";
import type { Prisma, ThreadEvents } from "@rakazo/db";
import {
  claimOrganizationForDeletion,
  claimSpacesLeavingWithAccount,
  deleteClaimedSpace,
  deleteEmptyOrganization,
  deletePageShareSecrets,
  expireSpaceDeletionClaims,
  keepOrganizationTrialUse,
  leaveInvitedSpaces,
  listStalledOrganizationDeletions,
  recordAuditEvent,
  recordComputerRunEnd,
  releaseOrganizationDeletionClaim,
  restoreSpaceDeletionClaims,
  runAsSystem,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  setOrganizationDeletionLease,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { BillingService } from "./billing.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { afterSpaceDeparture } from "./space-departure.js";

/**
 * In shared spaces, the account's bot folders also live on the space's Team Computer from before
 * each person got their own. Each sandbox is destroyed at its provider before its row goes, so a
 * failure keeps the handle and deleting again resumes from what is left.
 */
export async function deleteAccountContent(
  deps: SpaceDeletionDeps & {
    events: ThreadEvents;
    billing?: Pick<BillingService, "cancelForDeletedUser">;
  },
  userId: string,
): Promise<void> {
  const { claimId, attemptId, spaceIds, takenOver } = await claimSpacesLeavingWithAccount(
    deps.prisma,
    userId,
  );
  try {
    // Cancel under the claims, so a checkout opened while another organization's cancellation
    // waits is refused by the deletion check instead of outliving the account.
    await deps.billing?.cancelForDeletedUser(userId);
  } catch (error) {
    // Nothing was destroyed yet, so the account stays as it was: give back only what this
    // attempt claimed, keeping claims an earlier attempt left and other deletions' markers.
    await restoreSpaceDeletionClaims(deps.prisma, { claimId, attemptId }, takenOver);
    throw error;
  }
  const leaving = { OR: [{ userId }, { spaceId: { in: spaceIds } }] };
  try {
    // Then leave other people's Spaces, so what this account made there passes to their owners
    // instead of being torn down with it. None of them is claimed above: each keeps another full
    // member. As after leaving: tell members, stop the cancelled runs' work, free held screens,
    // and start others' waiting follow-ups.
    await leaveInvitedSpaces(deps.prisma, userId, (departure) =>
      afterSpaceDeparture(deps, { spaceId: departure.spaceId, userId }, departure),
    );
    await deleteClaimedSpaces(deps, {
      userId,
      operationId: `account-delete:${userId}`,
      claimId,
      spaceIds,
      soleMemberId: userId,
      bots: leaving,
      computers: leaving,
    });
  } catch (error) {
    // Nothing of this attempt is left running, so a retry takes its claims over at once.
    await expireSpaceDeletionClaims(deps.prisma, { claimId, attemptId });
    throw error;
  }

  // Pages in Spaces that stay go with the user row; their links' tokens leave the store now.
  const memberPageSecrets = await deps.prisma.$transaction((tx) =>
    deletePageShareSecrets(tx, { userId, spaceId: { notIn: spaceIds } }),
  );
  if (deps.secrets) await forgetPageShareSecrets(deps.secrets, memberPageSecrets);

  // Bot deletion cleans these best-effort; here a failure fails the account deletion, and the
  // retry finds the ids again in bot_deletions.
  const deletions = await deps.prisma.botDeletion.findMany({
    where: { deletedByUserId: userId, spaceId: { notIn: spaceIds } },
    select: { id: true, spaceId: true },
  });
  const deletedBySpace = new Map<string, string[]>();
  for (const { id, spaceId } of deletions)
    deletedBySpace.set(spaceId, [...(deletedBySpace.get(spaceId) ?? []), id]);
  await settleAll(
    [...deletedBySpace].map(([spaceId, botIds]) =>
      removeDeletedBotsFromLegacyTeamHome(deps, spaceId, botIds),
    ),
  );
}

type OrganizationDeletionDeps = SpaceDeletionDeps & {
  billing?: Pick<BillingService, "cancelForDeletedOrganization">;
};

/** Bounds one attempt. Providers may ignore the abort signal, so without it a hung teardown would
 * keep renewing the lease and no later attempt could resume. */
const ORGANIZATION_DELETION_TIMEOUT_MS = 15 * 60_000;
const LEASE_RENEWAL_MS = SPACE_DELETION_CLAIM_TIMEOUT_MS / 5;
const LEASE_KEPT_MS = SPACE_DELETION_CLAIM_TIMEOUT_MS - LEASE_RENEWAL_MS;

/**
 * Claiming hides the organization from the owner's list. Its subscriptions are cancelled before
 * anything is destroyed, and a billing failure releases the claim, so the organization stays as it
 * was; any later failure leaves the Spaces claimed, and deleting again, or the sweep once the lease
 * lapses, finishes. The attempt renews its lease while it runs, so no other attempt overlaps it.
 * Audit events keep no foreign key to their organization, so the record outlives it.
 */
export async function deleteOrganization(
  deps: OrganizationDeletionDeps,
  userId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const organization = await deps.prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const { claimId, spaceIds, fresh } = await claimOrganizationForDeletion(deps.prisma, {
    userId,
    organizationId,
  });
  // Once another attempt may take the claim over, this one is cancelled: when a renewal finds the
  // claim taken, or when no renewal has landed for nearly the whole lease, one interval short of it.
  const lease = new AbortController();
  const loseLease = () => lease.abort(new Error("Organization deletion lost its claim"));
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const keepLeaseFor = (from: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(loseLease, from + LEASE_KEPT_MS - Date.now());
  };
  keepLeaseFor(Date.now());
  let renewing: Promise<void> | undefined;
  const renew = async () => {
    const at = new Date();
    if (await setOrganizationDeletionLease(deps.prisma, { organizationId, claimId, at })) {
      keepLeaseFor(at.getTime());
      return;
    }
    clearInterval(renewal);
    // No Space left means this attempt deleted them, and only its file cleanup and record remain,
    // still under the overall deadline; any left are another attempt's.
    if (await deps.prisma.space.count({ where: { organizationId } })) loseLease();
    else clearTimeout(expiry);
  };
  const renewal = setInterval(() => {
    renewing ??= renew()
      .catch((error) => getLogger().error("organization deletion lease renewal failed", error))
      .finally(() => {
        renewing = undefined;
      });
  }, LEASE_RENEWAL_MS);
  const deadline = requestDeadline(
    ORGANIZATION_DELETION_TIMEOUT_MS,
    "Organization deletion timed out",
    signal ? anySignal([signal, lease.signal]) : lease.signal,
  );
  const operationId = `organization-delete:${organizationId}`;
  let billingCancelled = false;
  // Work cut off by the deadline or a lost lease that resumes later starts nothing new: a later
  // attempt may own it.
  const stillLeased = () => deadline.signal.throwIfAborted();
  const work = async () => {
    await keepOrganizationTrialUse(deps.prisma, organizationId);
    stillLeased();
    await deps.billing?.cancelForDeletedOrganization(organizationId);
    billingCancelled = true;
    stillLeased();
    const inOrganization = { spaceId: { in: spaceIds } };
    // The claim leaves the owner as its only member, so every Space goes: its files can go before
    // the rows that list them, and a failed removal is found again on retry.
    const artifacts = await deps.prisma.artifact.findMany({
      where: inOrganization,
      select: { spaceId: true, storageKey: true },
    });
    stillLeased();
    await settleAll(
      artifacts.map(({ spaceId, storageKey }) =>
        deps.artifacts.remove(
          storageKey,
          adapterContext(operationId, userId, spaceId, undefined, deadline.signal),
        ),
      ),
    );
    await deleteClaimedSpaces(deps, {
      userId,
      operationId,
      claimId,
      spaceIds,
      organizationId,
      bots: inOrganization,
      computers: inOrganization,
      signal: deadline.signal,
    });
    stillLeased();
    await deleteEmptyOrganization(deps.prisma, organizationId);
    await recordAuditEvent({
      action: "organization.deleted",
      actor: { type: "user", id: userId },
      organizationId,
      target: { type: "organization", id: organizationId, label: organization?.name ?? null },
    });
  };
  try {
    await withAbort(work(), deadline.signal);
  } catch (error) {
    clearInterval(renewal);
    await renewing;
    // Work cut off by the deadline or a lost lease may still be running, so the lease is left to
    // lapse or to the attempt that took it. Otherwise nothing is left running and the next attempt
    // may start at once.
    if (!deadline.signal.aborted) {
      if (fresh && !billingCancelled)
        await releaseOrganizationDeletionClaim(deps.prisma, { organizationId, claimId });
      else
        await setOrganizationDeletionLease(deps.prisma, {
          organizationId,
          claimId,
          at: new Date(0),
        });
    }
    throw error;
  } finally {
    clearInterval(renewal);
    clearTimeout(expiry);
    deadline.dispose();
  }
}

/** Finishes organization deletions that stopped part way, such as on a provider failure or restart. */
export function finishStalledOrganizationDeletions(
  deps: OrganizationDeletionDeps,
): (signal: AbortSignal) => Promise<void> {
  return (signal) =>
    runAsSystem("finish stalled organization deletions", async () => {
      // Each deletion holds its own lease and deadline, so a hung provider holds up no other.
      const stalled = await listStalledOrganizationDeletions(deps.prisma);
      await Promise.all(
        stalled.map(({ id, ownerId }) =>
          deleteOrganization(deps, ownerId, id, signal).catch((error) =>
            getLogger().error("stalled organization deletion failed", error),
          ),
        ),
      );
    });
}

/** Tears down the bots and computers matched, then deletes the claimed Spaces and their files. */
async function deleteClaimedSpaces(
  deps: SpaceDeletionDeps,
  input: {
    userId: string;
    operationId: string;
    claimId: string;
    spaceIds: string[];
    soleMemberId?: string;
    /** Deletes the organization with its last Space. */
    organizationId?: string;
    bots: Prisma.BotWhereInput;
    computers: Prisma.ComputerWhereInput;
    signal?: AbortSignal;
  },
): Promise<void> {
  const context = (spaceId: string, botId?: string) =>
    adapterContext(input.operationId, input.userId, spaceId, botId, input.signal);
  const bots = await deps.prisma.bot.findMany({
    where: input.bots,
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
    },
  });
  input.signal?.throwIfAborted();
  await settleAll(
    bots.map((bot) =>
      destroyBot({ ...deps, secretStore: deps.secrets }, bot, context(bot.spaceId, bot.id), {
        deleteMemories: true,
        strictTeardown: true,
      }),
    ),
  );

  const computers = await deps.prisma.computer.findMany({
    where: input.computers,
    select: {
      id: true,
      spaceId: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      bots: { select: { id: true } },
    },
  });
  input.signal?.throwIfAborted();
  await settleAll(
    computers.map(async (computer) => {
      // Only someone else's bot can still be on it, and its files are theirs.
      if (computer.bots.length) {
        getLogger().warn("account.delete.computer_in_use", { "computer.id": computer.id });
        return;
      }
      if (computer.providerRef) {
        await deps.sandbox.destroy(toComputerRef(computer), context(computer.spaceId));
        await recordComputerRunEnd(deps.prisma, computer, "deleted");
      }
      await removeAgentHome(deps.home, computer.homeKey, deps.dataDir);
      // The row holds the stored home's key, so the stored copy is unreadable from here on.
      await deps.prisma.computer.deleteMany({
        where: { id: computer.id, providerRef: computer.providerRef, bots: { none: {} } },
      });
    }),
  );

  for (const spaceId of input.spaceIds) {
    // Teardown abandoned at a deadline that finishes later leaves the rest to the next attempt.
    input.signal?.throwIfAborted();
    const deleted = await deleteClaimedSpace(deps.prisma, {
      spaceId,
      claimId: input.claimId,
      soleMemberId: input.soleMemberId,
      organizationId: input.organizationId,
    });
    if (!deleted) continue;
    const cleanup = await Promise.allSettled(
      deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context(spaceId))),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, deleted.pageShareSecrets);
  }
}

function adapterContext(
  operationId: string,
  userId: string,
  spaceId: string,
  botId?: string,
  signal: AbortSignal = new AbortController().signal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId,
    userId,
    ...(botId ? { botId } : {}),
    signal,
  };
}

/** Runs every teardown, then fails with the first error so a retry finishes the rest. */
async function settleAll(work: Promise<unknown>[]) {
  const failed = (await Promise.allSettled(work)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

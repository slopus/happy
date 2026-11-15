import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { MemoryProviderResolver } from "@rakazo/adapters";
import {
  destroyBot,
  forgetPageShareSecrets,
  removeAgentHome,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  listClaimedSpaceBots,
  listClaimedSpaceComputers,
  recordComputerRunEnd,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { rehomeItemsLeaving } from "./availability.js";

/** Bound for one bot or sandbox teardown. Providers may ignore the abort signal,
 * so without a deadline a hung destroy would keep the deletion claim renewed
 * forever and block stale-claim recovery. */
const SPACE_TEARDOWN_TIMEOUT_MS = 120_000;

function spaceTeardownTimeoutMs(): number {
  const override = Number(process.env.SPACE_TEARDOWN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : SPACE_TEARDOWN_TIMEOUT_MS;
}

export type SpaceDeletionDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  memoryProviders: MemoryProviderResolver;
  artifacts: ArtifactStore;
  dataDir: string;
  messagingInstallations?: Parameters<typeof destroyBot>[0]["messagingInstallations"];
  /** Removes deleted page links' tokens from a remote secret store. */
  secrets?: Pick<SecretStore, "delete">;
};

/** The owner-only rules live in the db layer. A worker that dies mid-way leaves the Space
 * claimed; after the claim goes stale, deleting again resumes from what is left. */
export async function deleteSpaceWithContent(
  deps: SpaceDeletionDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  spaceId: string,
  signal?: AbortSignal,
): Promise<{ activeSpaceId: string }> {
  let claimId: string | null = null;
  let claimActive = false;
  let claimHealthy = true;
  let claimReleasable = false;
  let claimRenewal: ReturnType<typeof setInterval> | null = null;
  const deleteInput = { currentSpaceId: actor.spaceId, userId: actor.userId, spaceId };
  const context = (botId?: string): AdapterContext => ({
    operationId: `spaces.remove:${spaceId}`,
    traceId: `spaces.remove:${spaceId}`,
    spaceId,
    userId: actor.userId,
    ...(botId ? { botId } : {}),
    signal: new AbortController().signal,
  });
  try {
    // Claim before teardown. Bot and group creation take the same lifecycle lock
    // and reject the Space until deletion finishes or this claim is released.
    const claim = await claimSpaceDeletionForMember(deps.prisma, deleteInput);
    claimId = claim.claimId;
    claimActive = true;
    // A recovered worker can safely finish deletion, but cannot know whether the
    // previous worker still has teardown in flight. Keep the Space claimed on
    // failure so content cannot reuse it.
    claimReleasable = !claim.recovered;
    const claimedInput = { ...deleteInput, claimId };
    const assertClaim = async () => {
      if (!claimHealthy) throw new SpaceDeletionInProgressError();
      try {
        const renewed = await renewSpaceDeletionClaim(deps.prisma, claimedInput);
        if (!renewed) {
          claimHealthy = false;
          claimReleasable = false;
          throw new SpaceDeletionInProgressError();
        }
      } catch (error) {
        claimHealthy = false;
        claimReleasable = false;
        throw error;
      }
    };
    claimRenewal = setInterval(() => {
      void assertClaim().catch((renewalError) => {
        if (claimActive) getLogger().error("space deletion claim renewal failed", renewalError);
      });
    }, SPACE_DELETION_CLAIM_TIMEOUT_MS / 5);
    // Teardown may reach a remote service even when it fails. From the first one,
    // only a finished deletion may unblock the Space; a stale recovery must finish it.
    const teardown = async (work: () => Promise<unknown>, timeoutMessage: string) => {
      await assertClaim();
      claimReleasable = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Stop renewal so the claim goes stale and a later worker can
              // recover; never release, since the hung work may still complete.
              claimHealthy = false;
              claimReleasable = false;
              reject(new Error(timeoutMessage));
            }, spaceTeardownTimeoutMs());
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      await assertClaim();
    };

    for (const bot of await listClaimedSpaceBots(deps.prisma, claimedInput)) {
      try {
        await teardown(
          () =>
            destroyBot({ ...deps, secretStore: deps.secrets }, bot, context(bot.id), {
              deleteMemories: true,
              strictTeardown: true,
            }),
          "Space bot teardown timed out",
        );
      } catch (error) {
        // A takeover worker may have finished this bot first.
        if (!claimHealthy) throw error;
        const remaining = await deps.prisma.bot.findUnique({
          where: { id: bot.id },
          select: { id: true },
        });
        if (remaining) throw error;
      }
    }
    for (const computer of await listClaimedSpaceComputers(deps.prisma, claimedInput)) {
      await teardown(
        () => deps.sandbox.destroy(toComputerRef(computer), context(computer.homeKey)),
        "Space sandbox teardown timed out",
      );
      // Never clear a provider handle after this worker loses its claim.
      await deps.prisma.computer.updateMany({
        where: {
          spaceId,
          homeKey: computer.homeKey,
          providerRef: computer.providerRef,
          space: { deletionClaimId: claimId },
        },
        data: { state: "stopped", providerRef: null },
      });
      await recordComputerRunEnd(deps.prisma, computer, "deleted");
    }
    await assertClaim();
    claimActive = false;
    if (claimRenewal) {
      clearInterval(claimRenewal);
      claimRenewal = null;
    }
    await rehomeItemsLeaving(deps.prisma, spaceId);
    const deleted = await deleteClaimedSpaceForMember(deps.prisma, claimedInput);
    // Rows are gone; leftover stored files are unreachable, so cleanup failures only log.
    const cleanup = await Promise.allSettled([
      ...deleted.artifactKeys.map((storageKey) => deps.artifacts.remove(storageKey, context())),
      ...deleted.homeKeys.map((homeKey) => removeAgentHome(deps.home, homeKey, deps.dataDir)),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") getLogger().error("space file cleanup", result.reason);
    }
    if (deps.secrets) await forgetPageShareSecrets(deps.secrets, deleted.pageShareSecrets);
    return { activeSpaceId: deleted.id };
  } catch (error) {
    if (signal?.aborted) claimReleasable = false;
    if (claimId && claimReleasable) {
      await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId }).catch(
        (releaseError) => {
          getLogger().error("space deletion claim release failed", releaseError);
        },
      );
    }
    throw error;
  } finally {
    claimActive = false;
    if (claimRenewal) clearInterval(claimRenewal);
  }
}

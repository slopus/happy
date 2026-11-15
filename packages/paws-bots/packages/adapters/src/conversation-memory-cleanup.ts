import type { AdapterContext, BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import { memoryPurgeHistoryJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** Clear removes conversation-derived memory (summaries and learned turns) of the cleared chat's
 * generation, and again of the one before it. clearThread returns the generation from before its
 * increment, so the new chat's turns use the next one and are never purged here. Durable memories
 * remain in their Space-private containers. Failed purges retry through the existing queue when
 * a stable connection identity is available. This remains best effort: the rows are already
 * deleted, and a crash or queue outage before retry publication can leave stale memory. */
export async function purgeClearedConversationMemory(
  deps: {
    prisma: PrismaClient;
    memoryProviders: MemoryProviderResolver;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  context: AdapterContext,
  target:
    | { kind: "bot" | "group-member"; botId: string; threadId: string }
    | { kind: "group"; memberBotIds: string[]; threadId: string },
  historyCompactionGeneration: number,
): Promise<void> {
  const configuredMemory = await deps.memoryProviders.resolve(context.spaceId).catch((error) => {
    getLogger().error("semantic memory resolution after thread clear failed", error);
    return null;
  });
  if (!configuredMemory) return;
  // Group chats only feed memory through learned turns, which are keyed by thread. Providers that
  // purge by thread are purged even with learning off now, since earlier turns may be stored;
  // others key history by bot and generation alone, so purging a group's generations there would
  // delete the member bots' direct-chat summaries. A bot removed from the group still learned
  // from it, and its runs outlive the clear.
  if (
    target.kind !== "bot" &&
    configuredMemory.provider.describe().capabilities.purgesByThread !== true
  )
    return;
  let botIds: string[];
  if (target.kind === "group") {
    const ranHere = await deps.prisma.run
      .findMany({
        where: { threadId: target.threadId },
        distinct: ["botId"],
        select: { botId: true },
      })
      .catch((error) => {
        // Still purge the current members.
        getLogger().error("listing the bots that ran in a cleared group chat failed", error);
        return [];
      });
    botIds = [...new Set([...target.memberBotIds, ...ranHere.map((run) => run.botId)])];
  } else {
    // A departing member's cleanup must not widen to the other learners in a surviving group.
    botIds = [target.botId];
  }
  await Promise.all(
    botIds.map(async (botId) => {
      const request = {
        botId,
        threadId: target.threadId,
        generations: [Math.max(0, historyCompactionGeneration - 1), historyCompactionGeneration],
      };
      try {
        const purged = await configuredMemory.provider.purgeHistory(request, {
          ...context,
          botId,
          operationId: `thread-clear:${target.threadId}`,
        });
        if (!purged.ok) throw new Error(purged.error);
      } catch (error) {
        getLogger().error("semantic memory purge after thread clear failed", error);
        // Providers without a stable connection identity cannot safely retry after replacement.
        const connectionIdentity = configuredMemory.provider.connectionIdentity;
        if (!connectionIdentity) return;
        await deps.jobs
          .enqueue(
            memoryPurgeHistoryJob({
              ...request,
              spaceId: context.spaceId,
              userId: context.userId,
              connectionIdentity,
            }),
          )
          .catch((enqueueError) =>
            getLogger().error("semantic memory purge retry could not be queued", enqueueError),
          );
      }
    }),
  );
}

/** The queue retries failures; a revoked or replaced connection must never receive the old purge. */
export async function retryConversationMemoryPurge(
  deps: { memoryProviders: MemoryProviderResolver },
  payload: BackgroundJobPayloads["memory.purge-history"],
): Promise<void> {
  const configured = await deps.memoryProviders.resolve(payload.spaceId);
  if (!configured || configured.provider.connectionIdentity !== payload.connectionIdentity) return;
  const operationId = `memory.purge-history:${payload.threadId}:${payload.botId}`;
  const purged = await configured.provider.purgeHistory(
    { botId: payload.botId, threadId: payload.threadId, generations: payload.generations },
    {
      spaceId: payload.spaceId,
      userId: payload.userId,
      botId: payload.botId,
      operationId,
      traceId: operationId,
      signal: new AbortController().signal,
    },
  );
  if (!purged.ok) throw new Error(purged.error);
}

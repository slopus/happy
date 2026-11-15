import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import {
  isSandboxProviderOutage,
  routineJobKey,
  runContinueJob,
  runJobKey,
} from "@rakazo/adapter-kit";
import type { Actor, Bot, ComputerMode } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  GROUP_MEMBER_MIN,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  cancelRunsInTransaction,
  clearEndedRunState,
  computerScopeKey,
  createRepos,
  createThreadMessageInTransaction,
  deletePageShareSecrets,
  draftRecordingsOfLeaseInTransaction,
  expireComputerExecutionLeases,
  legacyTeamHomeKey,
  recordComputerRunEnd,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  teamComputerUserId,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { BrowserStoppedReleaseError } from "./computer-screens.js";
import { toComputerRef } from "./computer-support.js";
import {
  checkpointAndStopComputer,
  isTeamBotFolderName,
  removeComputerWorkspaceDirectories,
  teamBrowserProfileName,
  withCleanupDeadline,
} from "./computer-workspace.js";
import { purgeClearedConversationMemory } from "./conversation-memory-cleanup.js";
import { removeAgentHome, removeAgentHomeFolders } from "./home.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { forgetPageShareSecrets } from "./page-share-secrets.js";
import { removePiBotSessions } from "./pi-session.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

export function confirmSpawnedBotName(confirmName: string, botName: string) {
  if (confirmName !== botName) {
    return {
      ok: false as const,
      error: "confirm_name must exactly match the bot's name. Refusing to archive.",
    };
  }
  return { ok: true as const };
}

export async function spawnBot(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
  },
  input: {
    spawnedBy: {
      id: string;
      name: string;
      spaceId: string;
      userId: string;
    };
    runId: string;
    spawnKey: string;
    name: string;
    description?: string;
    instructions?: string;
    prompt?: string;
    computerMode?: ComputerMode;
  },
) {
  const name = input.name.trim();
  if (!name) return { error: "Bot name is required." };

  const actor: Actor = {
    userId: input.spawnedBy.userId,
    spaceId: input.spawnedBy.spaceId,
    email: "",
    isDeploymentOwner: false,
  };
  let duplicate = false;
  let created: Pick<Bot, "id" | "name" | "threadId">;
  try {
    created = await createRepos(deps.prisma).createBot(actor, {
      name,
      description: (input.description ?? "").trim().slice(0, BOT_DESCRIPTION_MAX_LENGTH),
      instructions: (input.instructions ?? "").trim().slice(0, BOT_INSTRUCTIONS_MAX_LENGTH),
      notifyOnFinish: true,
      // Creation provenance only; bots remain peers in the roster.
      parentBotId: input.spawnedBy.id,
      spawnKey: input.spawnKey,
      computerMode: input.computerMode,
      initialMessage: {
        role: "system",
        blocks: [{ kind: "meta", text: `Created by ${input.spawnedBy.name}` }],
        runId: input.runId,
      },
    });
  } catch (error) {
    const existing = await deps.prisma.bot.findUnique({
      where: {
        spaceId_spawnKey: {
          spaceId: input.spawnedBy.spaceId,
          spawnKey: input.spawnKey,
        },
      },
      include: { thread: true },
    });
    if (!existing) throw error;
    if (!existing.thread) throw new Error(`Spawned bot ${existing.id} is missing its thread`);
    duplicate = true;
    created = {
      id: existing.id,
      name: existing.name,
      threadId: existing.thread.id,
    };
  }

  const prompt = (input.prompt ?? "").trim();
  if (prompt) {
    const run = await ensureSpawnRun(deps.prisma, {
      spaceId: input.spawnedBy.spaceId,
      userId: input.spawnedBy.userId,
      botId: created.id,
      threadId: created.threadId,
      sourceRunId: input.runId,
      spawnKey: input.spawnKey,
      prompt,
    });
    await deps.jobs
      .enqueue(runContinueJob(run.id))
      .catch((error) => getLogger().error("spawned bot enqueue", error));
  }

  return {
    ok: true as const,
    ...(duplicate ? { duplicate: true as const } : {}),
    botId: created.id,
    name: created.name,
    threadId: created.threadId,
  };
}

async function ensureSpawnRun(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    sourceRunId: string;
    spawnKey: string;
    prompt: string;
  },
) {
  const clientNonce = `spawn:${input.spawnKey}`;
  const where = {
    spaceId_clientNonce: {
      spaceId: input.spaceId,
      clientNonce,
    },
  } as const;
  const existing = await prisma.run.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: [{ kind: "text", text: input.prompt }],
        runId: input.sourceRunId,
      });
      const task = await tx.task.create({
        data: {
          spaceId: input.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: input.userId,
          prompt: input.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: input.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: input.userId,
          status: "queued",
          trigger: "spawn",
          clientNonce,
        },
      });
    });
  } catch (error) {
    const winner = await prisma.run.findUnique({ where });
    if (winner) return winner;
    throw error;
  }
}

type BotLifecycleDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  dataDir?: string;
  memoryProviders?: MemoryProviderResolver;
  artifacts?: ArtifactStore;
  /** Removes deleted page links' sealed tokens from a remote secret store. */
  secretStore?: Pick<SecretStore, "delete">;
  messagingInstallations?: {
    removeForBot(bot: { id: string; spaceId: string; userId: string }): Promise<void>;
  };
};

type LifecycleBot = {
  id: string;
  spaceId: string;
  name: string;
  userId: string;
  archivedAt: Date | null;
  computerId?: string | null;
  webhookSecretId?: string | null;
};

/** Management stays within the current space, whichever member created the bot. */
export function managedBotsWhere(caller: { spaceId: string }): Prisma.BotWhereInput {
  return { spaceId: caller.spaceId };
}

/**
 * Creation provenance for the roster metadata, whichever member's run spawned the bot; this
 * does not grant management permissions.
 */
export function createdByWhere(caller: { botId: string; spaceId: string }): Prisma.BotWhereInput {
  return { parentBotId: caller.botId, spaceId: caller.spaceId };
}

export async function archiveSpawnedBot(
  deps: BotLifecycleDeps,
  input: {
    spawnedByBotId: string;
    userId: string;
    spaceId: string;
    confirmName: string;
    botId?: string;
  },
  context: AdapterContext,
) {
  const confirmName = input.confirmName.trim();
  if (!confirmName) {
    return { error: "confirm_name is required. Refusing to archive." };
  }

  // Archived bots stay eligible so retries can reconcile unfinished cleanup.
  const matches = await deps.prisma.bot.findMany({
    where: {
      ...managedBotsWhere(input),
      ...(input.botId ? { id: input.botId } : { name: confirmName }),
    },
    take: 2,
  });

  if (input.botId && matches.length === 0) {
    return { error: "That bot is not in this space. Refusing to archive." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `This space has no bot named "${confirmName}". Refusing to archive.` };
  }
  if (!input.botId && matches.length > 1) {
    return {
      error: `More than one bot is named "${confirmName}". Pass bot_id as well as confirm_name.`,
    };
  }

  const target = matches[0]!;
  const confirmed = confirmSpawnedBotName(confirmName, target.name);
  if (!confirmed.ok) return confirmed;
  if (target.id === input.spawnedByBotId) {
    return { error: "A bot cannot archive itself with archive_bot." };
  }

  await archiveBot(deps, target, context);
  return { ok: true as const, botId: target.id, name: target.name };
}

export async function archiveBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
) {
  const [dedicated, activeRuns, activeRoutines] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: {
        scopeKey: computerScopeKey({
          mode: "dedicated",
          spaceId: bot.spaceId,
          userId: bot.userId,
          botId: bot.id,
        }),
      },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    }),
    deps.prisma.routine.findMany({
      where: { botId: bot.id, active: true },
      select: { id: true },
    }),
  ]);
  const now = new Date();
  const cancelledRuns = await deps.prisma.$transaction(async (tx) => {
    const cancelled = await cancelRunsInTransaction(tx, activeRuns, now);
    await tx.routine.updateMany({
      where: { botId: bot.id },
      data: { active: false, nextRunAt: null },
    });
    await expireComputerExecutionLeases(tx, { botId: bot.id });
    // Archiving ends a person's control of the bot's screen, and the recording made under it.
    const held = await tx.computer.findMany({
      where: { controlBotId: bot.id, controlLeaseId: { not: null } },
      select: { spaceId: true, controlLeaseId: true },
    });
    await tx.computer.updateMany({
      where: {
        OR: [{ controlBotId: bot.id }, { executionBotId: bot.id }],
      },
      data: releasedComputerLease(),
    });
    for (const { spaceId, controlLeaseId } of held) {
      await draftRecordingsOfLeaseInTransaction(tx, { spaceId, leaseId: controlLeaseId! });
    }
    if (dedicated) {
      await tx.computer.updateMany({
        where: { id: dedicated.id, state: { notIn: ["running", "quarantined"] } },
        data: { state: "stopped" },
      });
    }
    await tx.bot.update({
      where: { id: bot.id },
      data: { archivedAt: bot.archivedAt ?? now, pinned: false },
    });
    return cancelled;
  });
  await Promise.allSettled([
    ...cancelledRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...activeRoutines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  await releaseTeamComputerScreen(deps, bot, dedicated?.id, context);
  const currentDedicated = dedicated
    ? await deps.prisma.computer.findUnique({ where: { id: dedicated.id } })
    : null;
  if (currentDedicated?.providerRef && currentDedicated.state === "running") {
    const ref = toComputerRef(currentDedicated);
    await checkpointAndStopComputer(deps, currentDedicated, ref, context);
    await deps.prisma.computer.updateMany({
      where: {
        id: currentDedicated.id,
        state: "running",
        providerRef: currentDedicated.providerRef,
      },
      data: { state: "stopped" },
    });
    await recordComputerRunEnd(deps.prisma, currentDedicated, "stopped");
  }
}

export async function destroyBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
  options: {
    deleteMemories: boolean;
    /** Fail before deleting anything when the provider cannot confirm the sandbox is gone,
     * so the computer row keeps its handle for a retry. */
    strictTeardown?: boolean;
  },
) {
  await deps.messagingInstallations?.removeForBot(bot);
  const [dedicated, activeRuns, routines] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: {
        scopeKey: computerScopeKey({
          mode: "dedicated",
          spaceId: bot.spaceId,
          userId: bot.userId,
          botId: bot.id,
        }),
      },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    deps.prisma.routine.findMany({ where: { botId: bot.id }, select: { id: true } }),
  ]);
  const runIds = activeRuns.map((run) => run.id);
  await deps.prisma.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  await clearEndedRunState(deps.prisma, runIds);
  await Promise.allSettled([
    ...activeRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...routines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  const sharedComputer = await releaseTeamComputerScreen(deps, bot, dedicated?.id, context, {
    cancelRunWork: true,
  });
  if (dedicated?.providerRef) {
    const destroyed = deps.sandbox.destroy(toComputerRef(dedicated), context);
    await (options.strictTeardown ? destroyed : destroyed.catch(() => undefined));
  }
  // Keep the bot deletion transaction from committing if raw transcript cleanup fails.
  await removePiBotSessions(deps.dataDir, bot.userId, bot.id);
  // Deleting the bot deletes its thread, so this waits out snapshot reads holding that row.
  const deletion = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; webhookSecretId: string | null }>>`
        SELECT id, "webhookSecretId"
        FROM bots
        WHERE id = ${bot.id} AND "spaceId" = ${bot.spaceId}
        FOR UPDATE
      `;
      // A concurrent removal of the same bot committed while this one waited for the lock;
      // it owns the deletion and the cleanup that follows.
      if (locked.length === 0) return null;
      const webhookSecretId = locked[0]?.webhookSecretId ?? bot.webhookSecretId ?? null;
      const { deleteMemories } = options;
      // The thread cascades with the bot; retain its namespace only when deletion was requested.
      const directMemory =
        deleteMemories && deps.memoryProviders
          ? await tx.thread.findUnique({
              where: { botId: bot.id },
              select: { id: true, historyCompactionGeneration: true },
            })
          : null;
      const botArtifacts = await tx.artifact.findMany({
        where: { botId: bot.id, groupId: null, spaceId: bot.spaceId },
        select: { storageKey: true },
      });
      await tx.artifact.deleteMany({
        where: { botId: bot.id, groupId: null, spaceId: bot.spaceId },
      });
      // Like its files, the bot's own pages and their links go with it; group pages stay.
      const botPages = { botId: bot.id, groupId: null, spaceId: bot.spaceId };
      const pageShareSecrets = await deletePageShareSecrets(tx, botPages);
      await tx.page.deleteMany({ where: botPages });
      const groupCleanup = await detachBotFromGroups(tx, bot.id);
      // Membership can have ended earlier; recorded runs still name every surviving group
      // whose learned sessions belong to this bot, until the bot's cascade removes those runs.
      const groupMemberMemory =
        deleteMemories && deps.memoryProviders
          ? await tx.run.findMany({
              where: { botId: bot.id, thread: { groupId: { not: null } } },
              distinct: ["threadId"],
              select: { thread: { select: { id: true, historyCompactionGeneration: true } } },
            })
          : [];
      await tx.computerExecutionLease.deleteMany({ where: { botId: bot.id } });
      await tx.computer.updateMany({
        where: {
          ...(dedicated ? { id: { not: dedicated.id } } : {}),
          OR: [{ controlBotId: bot.id }, { executionBotId: bot.id }],
        },
        data: releasedComputerLease(),
      });
      if (!deleteMemories) {
        const directory = archivedMemoryDirectory(bot.name, bot.id);
        await tx.$executeRaw`
          UPDATE "memory_documents"
          SET "botId" = NULL,
              "scope" = 'user',
              "path" = ${directory} || '/' || "path",
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "botId" = ${bot.id}
        `;
      }
      await tx.botDeletion.create({
        data: {
          id: bot.id,
          spaceId: bot.spaceId,
          name: bot.name,
          deletedByUserId: context.userId,
          memoriesPreserved: !deleteMemories,
        },
      });
      await tx.bot.delete({ where: { id: bot.id } });
      if (webhookSecretId) {
        await tx.secret.deleteMany({
          where: { id: webhookSecretId, kind: "webhook", spaceId: bot.spaceId },
        });
      }
      if (dedicated) await tx.computer.delete({ where: { id: dedicated.id } });
      return {
        artifactKeys: [
          ...botArtifacts.map((artifact) => artifact.storageKey),
          ...groupCleanup.artifactKeys,
        ],
        removedGroupIds: groupCleanup.removedGroupIds,
        directMemory,
        groupMemberMemory: groupMemberMemory.map((run) => run.thread),
        groupMemory: groupCleanup.memory,
        cancelledGroupRuns: groupCleanup.cancelledRuns,
        pageShareSecrets: [...pageShareSecrets, ...groupCleanup.pageShareSecrets],
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  if (!deletion) return { removedGroupIds: [] as string[], alreadyRemoved: true };
  await Promise.allSettled(
    deletion.cancelledGroupRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
  );
  const stoppedGroupBots = [
    ...new Map(
      deletion.cancelledGroupRuns.map((run) => [
        run.botId,
        { id: run.botId, computer: run.computer },
      ]),
    ).values(),
  ];
  await Promise.all(
    stoppedGroupBots.map(async (stoppedBot) => {
      if (!stoppedBot.computer?.providerRef) return;
      await deps.sandbox
        .releaseScreen?.(toComputerRef(stoppedBot.computer), {
          ...context,
          operationId: `destroy-group-run:${stoppedBot.id}`,
          botId: stoppedBot.id,
        })
        .catch(() => undefined);
    }),
  );
  if (deps.memoryProviders) {
    const memory = { prisma: deps.prisma, memoryProviders: deps.memoryProviders, jobs: deps.jobs };
    await Promise.all(
      deletion.groupMemory.map((group) =>
        purgeClearedConversationMemory(
          memory,
          context,
          {
            kind: "group",
            threadId: group.threadId,
            memberBotIds: group.botIds,
          },
          group.generation,
        ).catch((error) => getLogger().error("dissolved group memory cleanup", error)),
      ),
    );
    await Promise.all(
      deletion.groupMemberMemory.map((thread) =>
        purgeClearedConversationMemory(
          memory,
          context,
          {
            kind: "group-member",
            botId: bot.id,
            threadId: thread.id,
          },
          thread.historyCompactionGeneration,
        ).catch((error) => getLogger().error("deleted bot group memory cleanup", error)),
      ),
    );
    if (deletion.directMemory) {
      await purgeClearedConversationMemory(
        memory,
        context,
        { kind: "bot", botId: bot.id, threadId: deletion.directMemory.id },
        deletion.directMemory.historyCompactionGeneration,
      ).catch((error) => getLogger().error("deleted bot conversation memory cleanup", error));
    }
  }
  if (dedicated) {
    await recordComputerRunEnd(deps.prisma, { id: dedicated.id }, "deleted");
    await removeAgentHome(deps.home, dedicated.homeKey, deps.dataDir).catch(() => undefined);
  }
  await removeTeamBrowserProfile(deps, bot.id, sharedComputer, context);
  await removeTeamBotWorkspace(deps, bot, context).catch((error) => {
    getLogger().error("team bot folder cleanup", error);
  });
  const artifactStore = deps.artifacts;
  if (artifactStore) {
    await removeStoredArtifacts(artifactStore, deletion.artifactKeys, context);
  }
  if (deps.secretStore) await forgetPageShareSecrets(deps.secretStore, deletion.pageShareSecrets);
  return { removedGroupIds: deletion.removedGroupIds };
}

type DissolvableGroup = {
  members: ReadonlyArray<{ botId: string; bot: { archivedAt: Date | null } }>;
};

/**
 * Groups left with fewer than two active bots once `botId` is gone.
 * Removal and its preview both decide here, so the warning names what the delete removes.
 */
function groupsDissolvedByRemovingBot<T extends DissolvableGroup>(
  groups: readonly T[],
  botId: string,
): T[] {
  return groups.filter((group) => {
    const activeMembersAfterDeletion = group.members.filter(
      (member) => member.botId !== botId && member.bot.archivedAt === null,
    ).length;
    return activeMembersAfterDeletion < GROUP_MEMBER_MIN;
  });
}

/** The groups `destroyBot` dissolves for this bot, as `{ id, name }`. Read-only. */
export async function groupsRemovedByDeletingBot(prisma: PrismaClient, botId: string) {
  const groups = await prisma.chatGroup.findMany({
    where: { members: { some: { botId } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
    },
  });
  return groupsDissolvedByRemovingBot(groups, botId).map((group) => ({
    id: group.id,
    name: group.name,
  }));
}

async function detachBotFromGroups(tx: Prisma.TransactionClient, botId: string) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT groups.id
    FROM chat_groups AS groups
    INNER JOIN chat_group_members AS members ON members."groupId" = groups.id
    WHERE members."botId" = ${botId}
    ORDER BY groups.id
    FOR UPDATE OF groups
  `;
  const affectedGroups = await tx.chatGroup.findMany({
    where: { members: { some: { botId } } },
    include: {
      members: {
        select: { botId: true, bot: { select: { archivedAt: true } } },
      },
      thread: { select: { id: true, historyCompactionGeneration: true } },
    },
  });
  const dissolvedGroupIds = groupsDissolvedByRemovingBot(affectedGroups, botId).map(
    (group) => group.id,
  );
  const dissolvedGroupIdSet = new Set(dissolvedGroupIds);
  const dissolvedThreadIds = affectedGroups
    .filter((group) => dissolvedGroupIdSet.has(group.id))
    .flatMap((group) => (group.thread ? [group.thread.id] : []));
  // Capture all learners before the group cascades away, including bots no longer in it.
  const learners = dissolvedThreadIds.length
    ? await tx.run.findMany({
        where: { threadId: { in: dissolvedThreadIds } },
        distinct: ["threadId", "botId"],
        select: { threadId: true, botId: true },
      })
    : [];
  const memory = affectedGroups
    .filter((group) => dissolvedGroupIdSet.has(group.id))
    .flatMap((group) =>
      group.thread
        ? [
            {
              threadId: group.thread.id,
              generation: group.thread.historyCompactionGeneration,
              botIds: [
                ...new Set([
                  ...group.members.map((member) => member.botId),
                  ...learners
                    .filter((run) => run.threadId === group.thread!.id)
                    .map((run) => run.botId),
                ]),
              ],
            },
          ]
        : [],
    );
  const activeRuns = dissolvedThreadIds.length
    ? await tx.run.findMany({
        where: {
          threadId: { in: dissolvedThreadIds },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: {
          id: true,
          taskId: true,
          userId: true,
          spaceId: true,
          botId: true,
          bot: {
            select: {
              computer: { select: { homeKey: true, kind: true, providerRef: true } },
            },
          },
        },
      })
    : [];
  const cancelledRuns = await cancelRunsInTransaction(tx, activeRuns, new Date());
  if (cancelledRuns.length) {
    const runIds = cancelledRuns.map((run) => run.id);
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  }
  if (affectedGroups.length) {
    await tx.chatGroupMember.deleteMany({ where: { botId } });
  }
  const groupArtifacts = dissolvedGroupIds.length
    ? await tx.artifact.findMany({
        where: { groupId: { in: dissolvedGroupIds } },
        select: { storageKey: true },
      })
    : [];
  const pageShareSecrets = dissolvedGroupIds.length
    ? await deletePageShareSecrets(tx, { groupId: { in: dissolvedGroupIds } })
    : [];
  if (dissolvedGroupIds.length) {
    await tx.chatGroup.deleteMany({ where: { id: { in: dissolvedGroupIds } } });
  }
  return {
    removedGroupIds: dissolvedGroupIds,
    memory,
    artifactKeys: groupArtifacts.map((artifact) => artifact.storageKey),
    pageShareSecrets,
    cancelledRuns: cancelledRuns.map((run) => ({
      id: run.id,
      botId: run.botId,
      computer: run.bot.computer,
    })),
  };
}

async function removeStoredArtifacts(
  artifacts: ArtifactStore | undefined,
  storageKeys: string[],
  context: AdapterContext,
) {
  if (!artifacts) return;
  const results = await Promise.allSettled(
    [...new Set(storageKeys)].map((storageKey) => artifacts.remove(storageKey, context)),
  );
  for (const result of results) {
    if (result.status === "rejected") getLogger().error("group artifact cleanup", result.reason);
  }
}

function archivedMemoryDirectory(name: string, botId: string) {
  const safeName = name.replace(/[\\/]/g, "-").trim() || "Bot";
  return `Archived bots/${safeName} (${botId})`;
}

function releasedComputerLease() {
  return {
    controlHolder: "none" as const,
    controlLeaseId: null,
    controlUserId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionRunId: null,
    executionBotId: null,
    executionLeaseExpiresAt: null,
  };
}

async function releaseTeamComputerScreen(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  dedicatedId: string | undefined,
  context: AdapterContext,
  options?: { cancelRunWork?: boolean },
) {
  const computer = await sharedTeamComputer(deps, bot, dedicatedId);
  if (!computer?.providerRef) return computer;
  // archive_bot runs inside the parent bot, and hard delete can omit botId.
  // Release this bot's screen; the caller's lease must not veto or redirect it.
  // Profile removal waits on the browser stop. A timed-out or failed stop can
  // return while Chromium is still exiting, and that process would recreate
  // the profile. A stop that succeeds and then fails while reacquiring the
  // screen lock or clearing the slot still removes the profile.
  try {
    await deps.sandbox.releaseScreen?.(toComputerRef(computer), {
      ...context,
      botId: bot.id,
      screenLeaseId: undefined,
      ...(options?.cancelRunWork ? { cancelRunWork: true } : {}),
    });
  } catch (error) {
    // No browser runs on a sandbox that is gone, so only its stored profile is left to remove.
    if (isSandboxGoneError(error)) return { ...computer, providerRef: null };
    if (isSandboxProviderOutage(error)) getLogger().warn("team screen release", { error });
    else getLogger().error("team screen release", error);
    if (error instanceof BrowserStoppedReleaseError) return computer;
    return null;
  }
  return computer;
}

async function sharedTeamComputer(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  dedicatedId: string | undefined,
) {
  if (!bot.computerId || bot.computerId === dedicatedId) return null;
  const computer = await deps.prisma.computer.findUnique({ where: { id: bot.computerId } });
  if (computer?.scope !== "team") return null;
  return computer;
}

const REMOTE_TEAM_SANDBOX_KINDS = new Set([
  "e2b",
  "novita",
  "instabox",
  "daytona",
  "boat",
  "createos",
  "kubernetes",
  "incus",
  "local-vm",
]);

/**
 * Whether only the server writes this computer's stored home. A Kubernetes computer that
 * mounts the server's home directory writes it itself, like a Docker computer.
 */
function serverOwnsTeamHome(sandbox: SandboxProvider, kind: string) {
  if (!REMOTE_TEAM_SANDBOX_KINDS.has(kind)) return false;
  return !(kind === "kubernetes" && sandbox.describe().capabilities.persistentHome);
}
// The bot is already deleted; whatever this misses is removed when the computer next boots.
const LIVE_CLEANUP_BUDGET_MS = 10_000;

async function removeTeamBrowserProfile(
  deps: BotLifecycleDeps,
  botId: string,
  computer: {
    scope: string;
    homeKey: string;
    kind: string;
    providerRef: string | null;
    state: string;
  } | null,
  context: AdapterContext,
) {
  if (computer?.scope !== "team") return;
  const name = teamBrowserProfileName(botId);
  if (!name) return;
  const profileContext = { ...context, botId, screenLeaseId: undefined };
  // Only a running computer is cleaned now, since connecting can start a stopped one; others
  // drop the profile on their next boot. Only a remote provider's stored copy is deleted on
  // the server. See removeTeamBotWorkspace.
  if (computer.providerRef && deps.sandbox.releaseScreen && computer.state === "running") {
    await withCleanupDeadline(profileContext, LIVE_CLEANUP_BUDGET_MS, (cleanupContext) =>
      removeProfileOnceClosed(deps.sandbox, toComputerRef(computer), name, cleanupContext),
    ).catch((error) => {
      // Chromium's helpers can hold the profile's databases open briefly after the stop.
      if (isBusyError(error)) {
        getLogger().warn("team browser profile still open; removed on next boot");
        return;
      }
      getLogger().error("team browser profile cleanup", error);
    });
  }
  if (!serverOwnsTeamHome(deps.sandbox, computer.kind)) return;
  await removeAgentHomeFolders(
    deps.home,
    computer.homeKey,
    ".browser-profiles",
    [name],
    deps.dataDir,
  ).catch((error) => {
    getLogger().error("team browser profile cleanup", error);
  });
}

const PROFILE_BUSY_ATTEMPTS = 3;
const PROFILE_BUSY_RETRY_MS = 1_000;

function isBusyError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    (error as NodeJS.ErrnoException).code === "EBUSY" ||
    error.message.includes("Device or resource busy")
  );
}

async function removeProfileOnceClosed(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  name: string,
  context: AdapterContext,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeComputerWorkspaceDirectories(
        sandbox,
        computer,
        ".browser-profiles",
        [name],
        context,
      );
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt >= PROFILE_BUSY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, PROFILE_BUSY_RETRY_MS));
      context.signal.throwIfAborted();
    }
  }
}

/** A Team Computer that is not running removes the folder when it next boots. */
async function removeTeamBotWorkspace(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
) {
  if (!isTeamBotFolderName(bot.id)) return;
  // Look the Space's Team Computer up by scope: a bot moved to its own computer can still have
  // a folder there. The space's Team Computer from before each person got their own still holds
  // the folders and browser profiles of every member's bots from then. Any other team computer
  // in the space drops them on boot (botDeletion).
  const teamUserId = await teamComputerUserId(deps.prisma, bot);
  const [own, legacy] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: {
        scopeKey: computerScopeKey({ mode: "team", spaceId: bot.spaceId, userId: teamUserId }),
      },
    }),
    deps.prisma.computer.findUnique({ where: { homeKey: legacyTeamHomeKey(bot.spaceId) } }),
  ]);
  const profile = teamBrowserProfileName(bot.id);
  if (own) await removeBotFolders(deps, bot.id, own, [["bots", bot.id]], context);
  if (legacy && legacy.id !== own?.id && legacy.scope === "team") {
    await removeBotFolders(
      deps,
      bot.id,
      legacy,
      [["bots", bot.id], ...(profile ? [[".browser-profiles", profile] as const] : [])],
      context,
    );
  }
}

/**
 * Remove deleted bots' folders and browser profiles from the stored home of the space's Team
 * Computer from before each person got their own. Throws when the stored copy could not be
 * saved; bot_deletions keeps the ids, so the caller can retry.
 */
export async function removeDeletedBotsFromLegacyTeamHome(
  deps: Pick<BotLifecycleDeps, "prisma" | "home" | "sandbox" | "dataDir">,
  spaceId: string,
  botIds: readonly string[],
) {
  const legacy = await deps.prisma.computer.findUnique({
    where: { homeKey: legacyTeamHomeKey(spaceId) },
  });
  // Only a remote provider's stored copy is written by the server alone; see removeBotFolders.
  if (legacy?.scope !== "team" || !serverOwnsTeamHome(deps.sandbox, legacy.kind)) return;
  const folders = botIds.filter(isTeamBotFolderName);
  const profiles = botIds.flatMap((id) => teamBrowserProfileName(id) ?? []);
  if (folders.length)
    await removeAgentHomeFolders(deps.home, legacy.homeKey, "bots", folders, deps.dataDir);
  if (profiles.length)
    await removeAgentHomeFolders(
      deps.home,
      legacy.homeKey,
      ".browser-profiles",
      profiles,
      deps.dataDir,
    );
}

async function removeBotFolders(
  deps: BotLifecycleDeps,
  botId: string,
  computer: { homeKey: string; kind: string; providerRef: string | null; state: string },
  folders: ReadonlyArray<readonly [".browser-profiles" | "bots", string]>,
  context: AdapterContext,
) {
  // Remote providers keep a stored copy that only the server writes, and replacement computers
  // restore from it. Any other home may be mounted by a running computer, where a bot could
  // swap bots/ for a symlink between the checks and rm, so it is only cleaned inside the computer.
  if (serverOwnsTeamHome(deps.sandbox, computer.kind)) {
    for (const [parent, name] of folders) {
      await removeAgentHomeFolders(deps.home, computer.homeKey, parent, [name], deps.dataDir).catch(
        (error) => {
          getLogger().error("team bot folder cleanup", error);
        },
      );
    }
  }
  if (computer.state !== "running" || !computer.providerRef) return;
  const folderContext = { ...context, botId, screenLeaseId: undefined };
  const ref = toComputerRef(computer);
  await withCleanupDeadline(folderContext, LIVE_CLEANUP_BUDGET_MS, async (cleanupContext) => {
    for (const [parent, name] of folders) {
      await removeComputerWorkspaceDirectories(deps.sandbox, ref, parent, [name], cleanupContext);
    }
  }).catch((error) => {
    getLogger().error("team bot folder cleanup", error);
  });
}

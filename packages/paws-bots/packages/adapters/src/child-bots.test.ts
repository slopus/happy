import { execFileSync } from "node:child_process";
import type * as fsPromises from "node:fs/promises";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  CommandRequest,
  JobPublisher,
  SandboxProvider,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import type { createRepos, PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  archiveBot,
  archiveSpawnedBot,
  confirmSpawnedBotName,
  destroyBot,
  groupsRemovedByDeletingBot,
  managedBotsWhere,
  spawnBot,
} from "./child-bots.js";
import { BrowserStoppedReleaseError } from "./computer-screens.js";
import { LocalAgentHomeStore } from "./home.js";

const fsHooks = vi.hoisted(() => ({
  afterRealpath: undefined as ((resolved: string) => Promise<void>) | undefined,
}));

// Lets a test change the disk between a path check and the delete that follows it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      await fsHooks.afterRealpath?.(String(resolved));
      return resolved;
    },
  };
});

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

function noGroupMemberships() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
    chatGroup: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    chatGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe("spawned bot creation", () => {
  it("returns the existing child when a spawn is retried", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "child-1",
      name: "Scout",
      thread: { id: "thread-1" },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue({ id: "parent-1" }),
        findUnique,
      },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findUnique: vi.fn().mockResolvedValue({ id: "child-run-1" }) },
      $transaction: vi.fn().mockRejectedValue(new Error("unique spawn key")),
    } as unknown as PrismaClient;

    const result = await spawnBot(
      {
        prisma,
        jobs: { enqueue } as unknown as JobPublisher,
      },
      {
        spawnedBy: {
          id: "parent-1",
          name: "Chief",
          spaceId: "workspace-1",
          userId: "user-1",
        },
        runId: "run-retry",
        spawnKey: "tool-call-1",
        name: " Scout ",
        description: "Ignored on a retry",
        prompt: "Do not enqueue this twice",
      },
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        spaceId_spawnKey: {
          spaceId: "workspace-1",
          spawnKey: "tool-call-1",
        },
      },
      include: { thread: true },
    });
    expect(result).toEqual({
      ok: true,
      duplicate: true,
      botId: "child-1",
      name: "Scout",
      threadId: "thread-1",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("passes computerMode through to createBot", async () => {
    const createBot = vi.fn().mockResolvedValue({
      id: "child-2",
      name: "Painter",
      threadId: "thread-2",
    });
    const createReposSpy = vi.spyOn(await import("@rakazo/db"), "createRepos").mockReturnValue({
      createBot,
    } as unknown as ReturnType<typeof createRepos>);

    const result = await spawnBot(
      {
        prisma: {} as PrismaClient,
        jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
      },
      {
        spawnedBy: {
          id: "parent-1",
          name: "Chief",
          spaceId: "workspace-1",
          userId: "user-1",
        },
        runId: "run-1",
        spawnKey: "tool-call-2",
        name: "Painter",
        description: " Paints murals. ",
        instructions: " Ask before using the shared screen. ",
        computerMode: "dedicated",
      },
    );

    expect(createBot).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", spaceId: "workspace-1" }),
      expect.objectContaining({
        name: "Painter",
        description: "Paints murals.",
        instructions: "Ask before using the shared screen.",
        computerMode: "dedicated",
        parentBotId: "parent-1",
      }),
    );
    expect(result).toEqual({
      ok: true,
      botId: "child-2",
      name: "Painter",
      threadId: "thread-2",
    });
    createReposSpy.mockRestore();
  });
});
describe("spawned bot archival", () => {
  it("scopes management to the space without requiring a creator", () => {
    expect(managedBotsWhere({ spaceId: "space-1" })).toEqual({ spaceId: "space-1" });
  });

  it("refuses an out-of-scope bot before stopping work", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { bot: { findMany } } as unknown as PrismaClient;
    expect(
      await archiveSpawnedBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
        },
        {
          spawnedByBotId: "caller",
          userId: "user-1",
          spaceId: "space-1",
          botId: "outside",
          confirmName: "Outside",
        },
        context,
      ),
    ).toHaveProperty("error");
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", id: "outside" },
      take: 2,
    });
  });

  it("refuses when confirm_name does not match exactly", () => {
    expect(confirmSpawnedBotName("scout", "Scout")).toMatchObject({ ok: false });
    expect(confirmSpawnedBotName("Scout ", "Scout")).toMatchObject({ ok: false });
  });

  it("accepts an exact name match", () => {
    expect(confirmSpawnedBotName("Scout", "Scout")).toEqual({ ok: true });
  });

  it("reconciles a retry when the peer is already archived", async () => {
    const archivedAt = new Date("2026-08-16T12:00:00.000Z");
    const prisma = {
      bot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "child-1",
            spaceId: "workspace-1",
            userId: "user-1",
            parentBotId: null,
            name: "Scout",
            archivedAt,
          },
        ]),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          ...noGroupMemberships(),
          run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computer: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            findMany: vi.fn().mockResolvedValue([]),
          },
          bot: { update: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaClient;

    await expect(
      archiveSpawnedBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          spawnedByBotId: "parent-1",
          userId: "user-1",
          spaceId: "workspace-1",
          confirmName: "Scout",
          botId: "child-1",
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: true, botId: "child-1", name: "Scout" });
    expect(prisma.bot.findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace-1", id: "child-1" },
      take: 2,
    });
  });
});

describe("destroyBot", () => {
  it("removes its deleted pages' link tokens from the secret store once the delete commits", async () => {
    const order: string[] = [];
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const result = await callback({
        $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
        chatGroup: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        artifact: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        page: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        secret: {
          findMany: vi.fn().mockResolvedValue([{ id: "secret-1", ciphertext: "ref-1" }]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(0),
        botDeletion: { create: vi.fn().mockResolvedValue({}) },
        bot: { delete: vi.fn().mockResolvedValue({}) },
      });
      order.push("commit");
      return result;
    });
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const removeSecret = vi.fn(async () => {
      order.push("store delete");
    });

    await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        secretStore: { delete: removeSecret },
      },
      { id: "bot-1", spaceId: "workspace-1", userId: "user-1", name: "Gone", archivedAt: null },
      context,
      { deleteMemories: true },
    );

    expect(removeSecret).toHaveBeenCalledWith(
      "ref-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
    expect(order).toEqual(["commit", "store delete"]);
  });

  it("moves bot memories into shared memory before the cascading delete", async () => {
    const createDeletion = vi.fn().mockResolvedValue({});
    const deleteBot = vi.fn().mockResolvedValue({});
    const executeRaw = vi.fn().mockResolvedValue(1);
    const releaseComputers = vi.fn().mockResolvedValue({ count: 1 });
    const removeArtifact = vi.fn().mockResolvedValue(undefined);
    const findArtifacts = vi.fn().mockResolvedValue([{ storageKey: "stored-artifact" }]);
    const deleteArtifacts = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
        chatGroup: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        artifact: { findMany: findArtifacts, deleteMany: deleteArtifacts },
        page: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        secret: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: { updateMany: releaseComputers, findMany: vi.fn().mockResolvedValue([]) },
        $executeRaw: executeRaw,
        botDeletion: { create: createDeletion },
        bot: { delete: deleteBot },
      }),
    );
    const prisma = {
      bot: {
        findUnique: vi.fn(),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        artifacts: { remove: removeArtifact } as unknown as ArtifactStore,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
      { deleteMemories: false },
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(releaseComputers).toHaveBeenCalledWith({
      where: {
        OR: [{ controlBotId: "bot-1" }, { executionBotId: "bot-1" }],
      },
      data: expect.objectContaining({
        controlHolder: "none",
        controlBotId: null,
        executionBotId: null,
      }),
    });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
      "Archived bots/Researcher (bot-1)",
      "bot-1",
    ]);
    expect(createDeletion).toHaveBeenCalledWith({
      data: {
        id: "bot-1",
        spaceId: "workspace-1",
        name: "Researcher",
        deletedByUserId: "user-1",
        memoriesPreserved: true,
      },
    });
    expect(deleteBot).toHaveBeenCalledWith({ where: { id: "bot-1" } });
    expect(findArtifacts).toHaveBeenCalledWith({
      where: { botId: "bot-1", groupId: null, spaceId: "workspace-1" },
      select: { storageKey: true },
    });
    expect(deleteArtifacts).toHaveBeenCalledWith({
      where: { botId: "bot-1", groupId: null, spaceId: "workspace-1" },
    });
    expect(deleteArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBot.mock.invocationCallOrder[0]!,
    );
    expect(removeArtifact).toHaveBeenCalledWith("stored-artifact", context);
  });

  it("leaves the deletion to a concurrent removal that already deleted the bot", async () => {
    const createDeletion = vi.fn();
    const deleteBot = vi.fn();
    const removeArtifact = vi.fn();
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findMany: vi.fn(), deleteMany: vi.fn() },
        page: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        secret: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        botDeletion: { create: createDeletion },
        bot: { delete: deleteBot },
      }),
    );
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    const result = await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        artifacts: { remove: removeArtifact } as unknown as ArtifactStore,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
      { deleteMemories: false },
    );

    expect(result).toEqual({ removedGroupIds: [], alreadyRemoved: true });
    expect(transaction).toHaveBeenCalledOnce();
    expect(createDeletion).not.toHaveBeenCalled();
    expect(deleteBot).not.toHaveBeenCalled();
    expect(removeArtifact).not.toHaveBeenCalled();
  });

  it("deletes the waiting one-time answer of a run it cancels", async () => {
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
        chatGroup: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        artifact: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        page: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        secret: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
        botDeletion: { create: vi.fn().mockResolvedValue({}) },
        bot: { delete: vi.fn().mockResolvedValue({}) },
      }),
    );
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "run-1" }])
          .mockResolvedValueOnce([{ id: "run-1", userId: "user-1", spaceId: "workspace-1" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      externalEffect: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      message: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn().mockResolvedValue([]), deleteMany: deleteSecrets },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
      { deleteMemories: false },
    );

    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: { startsWith: "run-login:run-1:" } },
        ],
      },
    });
  });

  it.each([true, false])(
    "dissolves groups and purges only their learned conversations (deleteMemories=%s)",
    async (deleteMemories) => {
      const preservePersonal = vi.fn();
      const directThread = vi.fn(async () => ({
        id: "direct-thread",
        historyCompactionGeneration: 7,
      }));
      const purgeHistory = vi.fn<SemanticMemoryProvider["purgeHistory"]>(async () => ({
        ok: deleteMemories,
        value: undefined,
        error: "provider unavailable",
      }));
      const memoryProviders = {
        resolve: vi.fn(async () => ({
          provider: {
            describe: () => ({ capabilities: { purgesByThread: true } }),
            purgeHistory,
          } as unknown as SemanticMemoryProvider,
          defaultScope: "isolated" as const,
        })),
      };
      const deleteGroups = vi.fn().mockResolvedValue({ count: 1 });
      const deleteMemberships = vi.fn().mockResolvedValue({ count: 1 });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      // finished-run ended after the read, so the conditional cancel leaves it out.
      const cancelRuns = vi.fn().mockResolvedValue([{ id: "group-run" }]);
      const cancelAttempts = vi.fn().mockResolvedValue({ count: 1 });
      const cancelTasks = vi.fn().mockResolvedValue({ count: 1 });
      const deleteExecutionLeases = vi.fn().mockResolvedValue({ count: 1 });
      const expireExecutionLeases = vi.fn().mockResolvedValue({ count: 1 });
      const clearExecution = vi.fn().mockResolvedValue({ count: 1 });
      const queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }, { id: "group-2" }]);
      const activeGroupRuns = [
        {
          id: "group-run",
          taskId: "group-task",
          botId: "bot-2",
          bot: {
            computer: { homeKey: "team-home", kind: "fake", providerRef: "screen-1" },
          },
        },
        {
          id: "finished-run",
          taskId: "finished-task",
          botId: "bot-3",
          bot: {
            computer: { homeKey: "other-home", kind: "fake", providerRef: "screen-3" },
          },
        },
      ];
      const findRuns = vi.fn(async (args: { distinct?: string[]; where?: { botId?: string } }) =>
        args.where?.botId
          ? [
              { thread: { id: "thread-2", historyCompactionGeneration: 9 } },
              { thread: { id: "former-group-thread", historyCompactionGeneration: 11 } },
            ]
          : args.distinct
            ? [{ threadId: "thread-1", botId: "former-member" }]
            : activeGroupRuns,
      );
      const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
          message: { findMany: vi.fn(async () => []) },
          $queryRaw: queryRaw,
          thread: { findUnique: directThread },
          chatGroup: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: "group-1",
                thread: { id: "thread-1", historyCompactionGeneration: 3 },
                members: [
                  { botId: "bot-1", bot: { archivedAt: null } },
                  { botId: "bot-2", bot: { archivedAt: null } },
                ],
              },
              {
                id: "group-2",
                thread: { id: "thread-2" },
                members: [
                  { botId: "bot-1", bot: { archivedAt: null } },
                  { botId: "bot-2", bot: { archivedAt: null } },
                  { botId: "bot-3", bot: { archivedAt: null } },
                ],
              },
              {
                id: "group-3",
                thread: { id: "thread-3", historyCompactionGeneration: 5 },
                members: [
                  { botId: "bot-1", bot: { archivedAt: null } },
                  { botId: "bot-2", bot: { archivedAt: new Date() } },
                  { botId: "bot-3", bot: { archivedAt: null } },
                ],
              },
            ]),
            deleteMany: deleteGroups,
          },
          run: {
            findMany: findRuns,
            updateManyAndReturn: cancelRuns,
          },
          attempt: { updateMany: cancelAttempts },
          task: { updateMany: cancelTasks },
          secret: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
          chatGroupMember: { deleteMany: deleteMemberships },
          artifact: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          page: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          computerExecutionLease: {
            deleteMany: deleteExecutionLeases,
            updateMany: expireExecutionLeases,
          },
          computer: { updateMany: clearExecution },
          $executeRaw: preservePersonal,
          botDeletion: { create: vi.fn() },
          bot: { delete: vi.fn() },
        }),
      );
      const prisma = {
        computer: { findUnique: vi.fn().mockResolvedValue(null) },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        routine: { findMany: vi.fn().mockResolvedValue([]) },
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: transaction,
      } as unknown as PrismaClient;

      await destroyBot(
        {
          prisma,
          sandbox: { releaseScreen } as unknown as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel } as unknown as JobPublisher,
          memoryProviders,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
        },
        context,
        { deleteMemories },
      );

      expect(deleteGroups).toHaveBeenCalledWith({ where: { id: { in: ["group-1", "group-3"] } } });
      expect(deleteMemberships).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
      expect(deleteMemberships.mock.invocationCallOrder[0]!).toBeLessThan(
        deleteGroups.mock.invocationCallOrder[0]!,
      );
      expect(
        queryRaw.mock.calls.some(([query]) => String(query).includes("FROM chat_groups")),
      ).toBe(true);
      expect(findRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            threadId: { in: ["thread-1", "thread-3"] },
          }),
        }),
      );
      expect(cancelRuns).toHaveBeenCalledWith({
        where: {
          id: { in: ["group-run", "finished-run"] },
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
        data: {
          status: "cancelled",
          completedAt: expect.any(Date),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        select: { id: true },
      });
      expect(cancelAttempts).toHaveBeenCalledWith({
        where: { runId: { in: ["group-run"] }, status: "running" },
        data: { status: "cancelled", finishedAt: expect.any(Date) },
      });
      expect(cancelTasks).toHaveBeenCalledWith({
        where: { id: { in: ["group-task"] } },
        data: { status: "cancelled" },
      });
      expect(expireExecutionLeases).toHaveBeenCalledWith({
        where: { runId: { in: ["group-run"] } },
        data: { expiresAt: new Date(0) },
      });
      expect(deleteExecutionLeases).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
      expect(clearExecution).toHaveBeenCalledWith({
        where: { executionRunId: { in: ["group-run"] } },
        data: {
          executionRunId: null,
          executionBotId: null,
          executionLeaseExpiresAt: null,
        },
      });
      expect(cancel.mock.calls).toEqual([["run:group-run"]]);
      expect(releaseScreen).toHaveBeenCalledTimes(1);
      expect(releaseScreen).toHaveBeenCalledWith(
        { id: "screen-1", botId: "team-home", kind: "fake", providerRef: "screen-1" },
        expect.objectContaining({
          operationId: "destroy-group-run:bot-2",
          botId: "bot-2",
        }),
      );

      expect(purgeHistory.mock.calls.map(([request]) => request)).toEqual([
        { botId: "bot-1", threadId: "thread-1", generations: [2, 3] },
        { botId: "bot-2", threadId: "thread-1", generations: [2, 3] },
        { botId: "former-member", threadId: "thread-1", generations: [2, 3] },
        { botId: "bot-1", threadId: "thread-3", generations: [4, 5] },
        { botId: "bot-2", threadId: "thread-3", generations: [4, 5] },
        { botId: "bot-3", threadId: "thread-3", generations: [4, 5] },
        ...(deleteMemories
          ? [
              { botId: "bot-1", threadId: "thread-2", generations: [8, 9] },
              { botId: "bot-1", threadId: "former-group-thread", generations: [10, 11] },
              { botId: "bot-1", threadId: "direct-thread", generations: [6, 7] },
            ]
          : []),
      ]);
      expect(directThread).toHaveBeenCalledTimes(deleteMemories ? 1 : 0);
      expect(purgeHistory.mock.invocationCallOrder[0]!).toBeGreaterThan(
        deleteGroups.mock.invocationCallOrder[0]!,
      );
      // Preserving the deleted bot's personal documents remains independent of dissolved chats.
      expect(preservePersonal).toHaveBeenCalledTimes(deleteMemories ? 0 : 1);
      if (!deleteMemories)
        expect(String(preservePersonal.mock.calls[0]![0])).toContain("memory_documents");
    },
  );

  const cases = ["unchanged", "changed", "preview-failed", "empty"];
  it.each(cases)("returns committed group IDs (%s)", async (scenario) => {
    // group-1 has one other active member, group-2 keeps two, group-3's other member is archived.
    const groups = [
      {
        id: "group-1",
        name: "Alpha",
        thread: { id: "thread-1" },
        members: [
          { botId: "bot-1", bot: { archivedAt: null } },
          { botId: "bot-2", bot: { archivedAt: null } },
        ],
      },
      {
        id: "group-2",
        name: "Beta",
        thread: { id: "thread-2" },
        members: [
          { botId: "bot-1", bot: { archivedAt: null } },
          { botId: "bot-2", bot: { archivedAt: null } },
          { botId: "bot-3", bot: { archivedAt: null } },
        ],
      },
      {
        id: "group-3",
        name: "Gamma",
        thread: { id: "thread-3" },
        members: [
          { botId: "bot-1", bot: { archivedAt: null } },
          { botId: "bot-2", bot: { archivedAt: new Date() } },
          { botId: "bot-3", bot: { archivedAt: null } },
        ],
      },
    ];
    const deleteGroups = vi.fn().mockResolvedValue({ count: 2 });
    const findGroups = vi.fn().mockResolvedValue(groups);
    const committedGroups =
      scenario === "empty"
        ? []
        : scenario === "changed"
          ? groups.map((group) => ({
              ...group,
              members:
                group.id === "group-1"
                  ? groups[1]!.members
                  : group.id === "group-2"
                    ? groups[0]!.members
                    : group.members,
            }))
          : groups;
    const expectedIds =
      scenario === "empty"
        ? []
        : scenario === "changed"
          ? ["group-2", "group-3"]
          : ["group-1", "group-3"];
    const findGroupsDuringDelete = vi.fn().mockResolvedValue(committedGroups);
    if (scenario === "preview-failed")
      findGroups.mockRejectedValueOnce(new Error("preview unavailable"));
    const prisma = {
      chatGroup: { findMany: findGroups },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      spaceMember: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
          artifact: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          page: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          secret: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          chatGroup: {
            findMany: findGroupsDuringDelete,
            deleteMany: deleteGroups,
          },
          chatGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
          run: { findMany: vi.fn().mockResolvedValue([]) },
          computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computer: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            findMany: vi.fn().mockResolvedValue([]),
          },
          botDeletion: { create: vi.fn().mockResolvedValue({}) },
          bot: { delete: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaClient;

    const preview = await groupsRemovedByDeletingBot(prisma, "bot-1").catch(() => null);
    const removed = await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
      { deleteMemories: true },
    );

    expect(preview).toEqual(
      scenario === "preview-failed"
        ? null
        : [
            { id: "group-1", name: "Alpha" },
            { id: "group-3", name: "Gamma" },
          ],
    );
    expect(removed).toEqual({ removedGroupIds: expectedIds });
    if (expectedIds.length)
      expect(deleteGroups).toHaveBeenCalledWith({ where: { id: { in: expectedIds } } });
    else expect(deleteGroups).not.toHaveBeenCalled();
    const previewWhere = findGroups.mock.calls[0]?.[0].where;
    const deleteWhere = findGroupsDuringDelete.mock.calls[0]?.[0].where;
    expect(previewWhere).toEqual(deleteWhere);
    expect(previewWhere).toEqual({ members: { some: { botId: "bot-1" } } });
  });

  it("surfaces transaction failures instead of reporting deletion success", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("delete failed"));
    const prisma = {
      bot: {
        findUnique: vi.fn(),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          dataDir: "/tmp/rakazo-destroy-bot-test",
        },
        {
          id: "bot-1",
          userId: "user-1",
          spaceId: "workspace-1",
          name: "Researcher",
          archivedAt: null,
        },
        context,
        { deleteMemories: true },
      ),
    ).rejects.toThrow("delete failed");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("retries retryable transaction conflicts during deletion", async () => {
    const conflict = Object.assign(new Error("deadlock"), {
      code: "P2039",
      meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
    });
    const finalError = new Error("second attempt reached");
    const transaction = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(finalError);
    const prisma = {
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
        },
        context,
        { deleteMemories: true },
      ),
    ).rejects.toBe(finalError);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("stops the deleted team bot's screen and removes only its browser profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-delete-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const deletedProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"));
      const keptProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-2"));
      const keptNotes = path.join(teamHome, "bots", "bot-2", "notes.txt");
      await mkdir(deletedProfile, { recursive: true });
      await mkdir(path.dirname(keptNotes), { recursive: true });
      await mkdir(keptProfile, { recursive: true });
      await writeFile(path.join(deletedProfile, "Cookies"), "gone");
      await writeFile(path.join(keptProfile, "Cookies"), "keep");
      await writeFile(keptNotes, "keep");
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      // A running Docker computer removes the profile inside its mounted home.
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(teamHome, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      const prisma = deletionPrisma(team);

      await destroyBot(
        {
          prisma,
          sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
        { deleteMemories: true },
      );

      expect(releaseScreen).toHaveBeenCalledWith(
        {
          id: "container-1",
          botId: "team-workspace-1",
          kind: "docker",
          providerRef: "container-1",
        },
        expect.objectContaining({ botId: "bot-1", cancelRunWork: true }),
      );
      const releaseContext = releaseScreen.mock.calls[0]?.[1] as AdapterContext;
      expect(releaseContext.botId).toBe("bot-1");
      expect(releaseContext.screenLeaseId).toBeUndefined();
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "docker" }),
        {
          argv: [
            "bash",
            "-eu",
            "-c",
            expect.any(String),
            "bash",
            ".browser-profiles",
            profileDirectory("bot-1"),
          ],
          cwd: ".",
        },
        expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
      );
      await expect(access(deletedProfile)).rejects.toThrow();
      await expect(readFile(path.join(keptProfile, "Cookies"), "utf8")).resolves.toBe("keep");
      await expect(readFile(keptNotes, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a profile symlink instead of following it into another bot's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const linkedProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"));
      const keptProfile = path.join(teamHome, ".browser-profiles", profileDirectory("bot-2"));
      await mkdir(keptProfile, { recursive: true });
      await mkdir(path.dirname(linkedProfile), { recursive: true });
      await writeFile(path.join(keptProfile, "Cookies"), "keep");
      await symlink(keptProfile, linkedProfile);
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(linkedProfile)).rejects.toThrow();
      await expect(readFile(path.join(keptProfile, "Cookies"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked profile directory instead of deleting the directory it points at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-parent-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const decoy = path.join(teamHome, "decoy-profiles");
      const victim = path.join(decoy, profileDirectory("bot-1"));
      const notes = path.join(teamHome, "notes.txt");
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "Cookies"), "keep");
      await writeFile(notes, "keep");
      await symlink(decoy, path.join(teamHome, ".browser-profiles"));
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "Cookies"), "utf8")).resolves.toBe("keep");
      await expect(readFile(notes, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["e2b", "novita", "createos"])(
    "removes the deleted bot's profile from a %s sandbox after the browser stops",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-delete-"));
      const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-workspace-"));
      try {
        const home = new LocalAgentHomeStore(root);
        const teamHome = home.pathFor("team-workspace-1");
        await seedProfile(teamHome, "bot-1", "local-gone");
        await seedProfile(teamHome, "bot-2", "local-keep");
        await seedProfile(remote, "bot-1", "remote-gone");
        await seedProfile(remote, "bot-2", "remote-keep");
        const releaseScreen = vi.fn().mockResolvedValue(undefined);
        const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
          const result = runInWorkspace(remote, request.argv);
          if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
          yield { type: "exit" as const, code: result.code };
        });
        const team = {
          id: "team-computer",
          homeKey: "team-workspace-1",
          kind,
          providerRef: "sandbox-1",
          scope: "team",
          state: "running",
        };

        await destroyBot(
          {
            prisma: deletionPrisma(team),
            sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          },
          {
            id: "bot-1",
            spaceId: "workspace-1",
            userId: "user-1",
            name: "Researcher",
            archivedAt: null,
            computerId: team.id,
          },
          { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
          { deleteMemories: true },
        );

        expect(releaseScreen.mock.invocationCallOrder[0]).toBeLessThan(
          execute.mock.invocationCallOrder[0] ?? 0,
        );
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({ kind, providerRef: "sandbox-1" }),
          expect.objectContaining({
            cwd: ".",
            argv: [
              "bash",
              "-eu",
              "-c",
              expect.any(String),
              "bash",
              ".browser-profiles",
              profileDirectory("bot-1"),
            ],
          }),
          expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
        );
        await expect(
          access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
        ).rejects.toThrow();
        await expect(readFile(profileCookies(teamHome, "bot-2"), "utf8")).resolves.toBe(
          "local-keep",
        );
        await expect(
          access(path.join(remote, ".browser-profiles", profileDirectory("bot-1"))),
        ).rejects.toThrow();
        await expect(readFile(profileCookies(remote, "bot-2"), "utf8")).resolves.toBe(
          "remote-keep",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(remote, { recursive: true, force: true });
      }
    },
  );

  it("leaves a remote profile in place when its parent directory is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-symlink-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-remote-symlink-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-gone");
      const decoy = path.join(remote, "decoy-profiles");
      const victim = path.join(decoy, profileDirectory("bot-1"));
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, "Cookies"), "remote-keep");
      await symlink(decoy, path.join(remote, ".browser-profiles"));
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "boat",
        providerRef: "boat-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "Cookies"), "utf8")).resolves.toBe("remote-keep");
      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("does not remove a profile when stopping the browser fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-release-failed-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-release-failed-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-stay");
      await seedProfile(remote, "bot-1", "remote-stay");
      const execute = vi.fn();
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockRejectedValue(new Error("sandbox screen release timed out")),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      const profileCleanups = execute.mock.calls.filter((call) =>
        (call[1] as CommandRequest).argv.includes(".browser-profiles"),
      );
      expect(profileCleanups).toEqual([]);
      await expect(readFile(profileCookies(teamHome, "bot-1"), "utf8")).resolves.toBe("local-stay");
      await expect(readFile(profileCookies(remote, "bot-1"), "utf8")).resolves.toBe("remote-stay");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("removes local and remote profiles when the browser stopped but slot cleanup failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-slot-cleanup-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-slot-cleanup-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "local-gone");
      await seedProfile(teamHome, "bot-2", "local-keep");
      await seedProfile(remote, "bot-1", "remote-gone");
      await seedProfile(remote, "bot-2", "remote-keep");
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "createos",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockRejectedValue(new BrowserStoppedReleaseError()),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
      await expect(readFile(profileCookies(teamHome, "bot-2"), "utf8")).resolves.toBe("local-keep");
      await expect(
        access(path.join(remote, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
      await expect(readFile(profileCookies(remote, "bot-2"), "utf8")).resolves.toBe("remote-keep");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });
  it("does not wake a stopped remote Team Computer to remove the deleted bot's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-profile-stopped-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "stored-gone");
      const execute = vi.fn();
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "daytona",
        providerRef: "sandbox-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute).not.toHaveBeenCalled();
      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats releasing the screen of a Team Computer whose sandbox is gone as done", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-profile-gone-"));
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedProfile(teamHome, "bot-1", "stored-gone");
      const gone = Object.assign(new Error("Boat sandbox sandbox-1 is gone"), {
        name: "SandboxNotFoundError",
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "boat",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockRejectedValue(gone),
            execute: vi.fn().mockRejectedValue(gone),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(sink.events.map((event) => event.message)).not.toContain("team screen release");
      expect(sink.events.map((event) => event.message)).not.toContain(
        "team browser profile cleanup",
      );
      await expect(
        access(path.join(teamHome, ".browser-profiles", profileDirectory("bot-1"))),
      ).rejects.toThrow();
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the deleted bot's folder inside a running Docker Team Computer and keeps other folders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-delete-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "gone");
      await seedFile(teamHome, "bots/bot-10/notes.txt", "keep");
      await seedFile(teamHome, "bots/bot-2/notes.txt", "keep");
      await seedFile(teamHome, "shared/plan.txt", "keep");
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      // The container sees the same mounted home.
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(teamHome, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "docker", providerRef: "container-1" }),
        { argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "bot-1"], cwd: "." },
        expect.objectContaining({ botId: "bot-1" }),
      );
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(teamHome, "bots/bot-10/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
      await expect(readFile(path.join(teamHome, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
      await expect(readFile(path.join(teamHome, "shared/plan.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the Team Computer folder of a bot that moved to its own computer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-moved-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "gone");
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {} as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: "dedicated-computer",
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports deletion success when the in-computer folder cleanup never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let markStarted: () => void = () => undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let commandSignal: AbortSignal | undefined;
      // Never finishes and ignores aborts, like a wedged provider call.
      const execute = vi.fn((_computer: unknown, _request: CommandRequest, commandContext) => {
        commandSignal = (commandContext as AdapterContext).signal;
        markStarted();
        return (async function* () {
          await new Promise(() => undefined);
          yield { type: "exit" as const, code: 0 };
        })();
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "running",
      };
      const prisma = deletionPrisma(team);

      const deleting = destroyBot(
        {
          prisma,
          sandbox: { execute } as unknown as SandboxProvider,
          home: new LocalAgentHomeStore(path.join(tmpdir(), "rakazo-unused-home")),
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(deleting).resolves.toEqual({ removedGroupIds: [] });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(commandSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("when Chromium still holds the profile open", () => {
    const busy = "rm: cannot remove '.browser-profiles/x/Default/Cookies': Device or resource busy";
    const team = {
      id: "team-computer",
      homeKey: "team-workspace-1",
      kind: "docker",
      providerRef: "container-1",
      scope: "team",
      state: "running",
    };

    async function deleteWithBusyProfile(busyAttempts: number) {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let profileAttempts = 0;
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        if (request.argv.includes(".browser-profiles")) {
          profileAttempts += 1;
          if (profileAttempts <= busyAttempts) {
            yield { type: "stderr" as const, data: busy };
            yield { type: "exit" as const, code: 1 };
            return;
          }
        }
        yield { type: "exit" as const, code: 0 };
      });
      try {
        const deleting = destroyBot(
          {
            prisma: deletionPrisma(team),
            sandbox: {
              releaseScreen: vi.fn().mockResolvedValue(undefined),
              execute,
            } as unknown as SandboxProvider,
            home: new LocalAgentHomeStore(path.join(tmpdir(), "rakazo-unused-home")),
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          },
          {
            id: "bot-1",
            spaceId: "workspace-1",
            userId: "user-1",
            name: "Researcher",
            archivedAt: null,
            computerId: team.id,
          },
          context,
          { deleteMemories: true },
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(deleting).resolves.toEqual({ removedGroupIds: [] });
        return { profileAttempts, events: sink.events };
      } finally {
        vi.useRealTimers();
        installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
      }
    }

    it("retries removal once the browser lets go", async () => {
      const { profileAttempts, events } = await deleteWithBusyProfile(1);

      expect(profileAttempts).toBe(2);
      expect(events.filter((event) => event.level === "error")).toEqual([]);
    });

    it("leaves a profile that stays open for the next boot without reporting an error", async () => {
      const { profileAttempts, events } = await deleteWithBusyProfile(Number.POSITIVE_INFINITY);

      expect(profileAttempts).toBe(3);
      expect(events.filter((event) => event.level === "error")).toEqual([]);
      expect(events.map((event) => event.message)).toContain(
        "team browser profile still open; removed on next boot",
      );
    });
  });

  it("reports deletion success when the Team Computer lookup fails after the bot is deleted", async () => {
    const team = { id: "team-computer", homeKey: "team-workspace-1", scope: "team" };
    const prisma = deletionPrisma(team);
    vi.mocked(prisma.computer.findUnique).mockImplementation((async (query: {
      where: { scopeKey?: string };
    }) => {
      if (query.where.scopeKey === "team:workspace-1:user-1")
        throw new Error("database unavailable");
      return null;
    }) as never);

    await expect(
      destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: new LocalAgentHomeStore(path.join(tmpdir(), "rakazo-unused-home")),
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: null,
        },
        context,
        { deleteMemories: true },
      ),
    ).resolves.toEqual({ removedGroupIds: [] });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("removes the deleted bot's folder from a running remote Team Computer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-remote-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-remote-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "stored-gone");
      await seedFile(remote, "bots/bot-1/private.txt", "remote-gone");
      await seedFile(remote, "bots/bot-2/notes.txt", "remote-keep");
      await seedFile(remote, "shared/plan.txt", "remote-keep");
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
        { deleteMemories: true },
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "e2b", providerRef: "sandbox-1" }),
        {
          argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "bot-1"],
          cwd: ".",
        },
        expect.objectContaining({ botId: "bot-1", screenLeaseId: undefined }),
      );
      await expect(access(path.join(remote, "bots", "bot-1"))).rejects.toThrow();
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(remote, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
      await expect(readFile(path.join(remote, "shared/plan.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("removes the deleted bot's folder and profile from the space's shared Team Computer from before each person got their own", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-legacy-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const legacyHome = home.pathFor("team-workspace-1");
      const profile = path.basename(browserProfilePathForScreen("bot-1"));
      await seedFile(legacyHome, "bots/bot-1/old.txt", "gone");
      await seedFile(legacyHome, `.browser-profiles/${profile}/Cookies`, "gone");
      await seedFile(legacyHome, "bots/bot-2/work.txt", "another member's");
      const own = {
        id: "own-team",
        homeKey: "team-own",
        kind: "e2b",
        providerRef: null,
        scope: "team",
        state: "stopped",
      };
      const legacy = { ...own, id: "legacy-team", homeKey: "team-workspace-1", userId: "user-2" };
      const prisma = deletionPrisma(own);
      vi.mocked(prisma.computer.findUnique).mockImplementation((async (query: {
        where: { id?: string; scopeKey?: string; homeKey?: string };
      }) => {
        if (query.where.homeKey === legacy.homeKey) return legacy;
        if (query.where.id === own.id || query.where.scopeKey === "team:workspace-1:user-1")
          return own;
        return null;
      }) as never);

      await destroyBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: own.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(path.join(legacyHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(access(path.join(legacyHome, ".browser-profiles", profile))).rejects.toThrow();
      await expect(readFile(path.join(legacyHome, "bots/bot-2/work.txt"), "utf8")).resolves.toBe(
        "another member's",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not wake a stopped Team Computer to remove the deleted bot's folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-stopped-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-1/private.txt", "stored-gone");
      const execute = vi.fn(async function* (_computer: unknown, _request: CommandRequest) {
        yield { type: "exit" as const, code: 0 };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: "sandbox-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      expect(execute.mock.calls.some(([, request]) => request.argv.includes("bots"))).toBe(false);
      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unlinks a symlinked bot folder instead of following it into another bot's folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-symlink-"));
    const remote = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-symlink-workspace-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "bots/bot-2/notes.txt", "stored-keep");
      await symlink(path.join(teamHome, "bots", "bot-2"), path.join(teamHome, "bots", "bot-1"));
      await seedFile(remote, "bots/bot-2/notes.txt", "remote-keep");
      await symlink("bot-2", path.join(remote, "bots", "bot-1"));
      const execute = vi.fn(async function* (_computer: unknown, request: CommandRequest) {
        const result = runInWorkspace(remote, request.argv);
        if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
        yield { type: "exit" as const, code: result.code };
      });
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "boat",
        providerRef: "boat-1",
        scope: "team",
        state: "running",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
            execute,
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(access(path.join(teamHome, "bots", "bot-1"))).rejects.toThrow();
      await expect(access(path.join(remote, "bots", "bot-1"))).rejects.toThrow();
      await expect(readFile(path.join(teamHome, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "stored-keep",
      );
      await expect(readFile(path.join(remote, "bots/bot-2/notes.txt"), "utf8")).resolves.toBe(
        "remote-keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("leaves the Team Computer home alone when its bots folder is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-parent-symlink-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      await seedFile(teamHome, "decoy/bot-1/notes.txt", "keep");
      await symlink(path.join(teamHome, "decoy"), path.join(teamHome, "bots"));
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "e2b",
        providerRef: null,
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {} as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(teamHome, "decoy/bot-1/notes.txt"), "utf8")).resolves.toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["docker", "desktop"])(
    "leaves a stopped %s Team Computer's stored home to its next boot",
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-docker-stopped-"));
      try {
        const home = new LocalAgentHomeStore(root);
        const teamHome = home.pathFor("team-workspace-1");
        await seedFile(teamHome, "bots/bot-1/private.txt", "next-boot");
        const execute = vi.fn();
        const team = {
          id: "team-computer",
          homeKey: "team-workspace-1",
          kind,
          providerRef: "container-1",
          scope: "team",
          state: "stopped",
        };

        await destroyBot(
          {
            prisma: deletionPrisma(team),
            sandbox: { releaseScreen: vi.fn(), execute } as unknown as SandboxProvider,
            home,
            jobs: { cancel: vi.fn() } as unknown as JobPublisher,
          },
          {
            id: "bot-1",
            spaceId: "workspace-1",
            userId: "user-1",
            name: "Researcher",
            archivedAt: null,
            computerId: team.id,
          },
          context,
          { deleteMemories: true },
        );

        expect(execute).not.toHaveBeenCalled();
        await expect(readFile(path.join(teamHome, "bots/bot-1/private.txt"), "utf8")).resolves.toBe(
          "next-boot",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not delete outside a Docker home when a bot swaps bots/ for a symlink mid-cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-folder-swap-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const victim = path.join(root, "victim");
      await seedFile(teamHome, "bots/bot-1/private.txt", "next-boot");
      await seedFile(victim, "bot-1/keep.txt", "keep");
      const folder = await realpath(path.join(teamHome, "bots", "bot-1"));
      // A bot in the container replaces bots/ with a symlink right after the folder is resolved.
      fsHooks.afterRealpath = async (resolved) => {
        if (resolved !== folder) return;
        fsHooks.afterRealpath = undefined;
        await rename(path.join(teamHome, "bots"), path.join(teamHome, "bots-before-swap"));
        await symlink(victim, path.join(teamHome, "bots"));
      };
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: { releaseScreen: vi.fn() } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(path.join(victim, "bot-1/keep.txt"), "utf8")).resolves.toBe("keep");
    } finally {
      fsHooks.afterRealpath = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete outside a Docker home when a bot swaps .browser-profiles/ mid-cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-profile-swap-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const victim = path.join(root, "victim");
      await seedProfile(teamHome, "bot-1", "next-boot");
      await seedProfile(victim, "bot-1", "keep");
      const profile = await realpath(
        path.join(teamHome, ".browser-profiles", profileDirectory("bot-1")),
      );
      // A bot in the container replaces .browser-profiles/ right after the profile is resolved.
      fsHooks.afterRealpath = async (resolved) => {
        if (resolved !== profile) return;
        fsHooks.afterRealpath = undefined;
        await rename(
          path.join(teamHome, ".browser-profiles"),
          path.join(teamHome, "profiles-before-swap"),
        );
        await symlink(
          path.join(victim, ".browser-profiles"),
          path.join(teamHome, ".browser-profiles"),
        );
      };
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
        state: "stopped",
      };

      await destroyBot(
        {
          prisma: deletionPrisma(team),
          sandbox: {
            releaseScreen: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "bot-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Researcher",
          archivedAt: null,
          computerId: team.id,
        },
        context,
        { deleteMemories: true },
      );

      await expect(readFile(profileCookies(victim, "bot-1"), "utf8")).resolves.toBe("keep");
      await expect(readFile(profileCookies(teamHome, "bot-1"), "utf8")).resolves.toBe("next-boot");
    } finally {
      fsHooks.afterRealpath = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("archiveBot", () => {
  it.each(["completed", "failed", "cancelled"])(
    "preserves a run that becomes %s after the active-run snapshot",
    async (terminalStatus) => {
      const endedAt = new Date("2026-08-16T12:00:00.000Z");
      const finished = {
        id: "finished-run",
        taskId: "finished-task",
        userId: "user-1",
        spaceId: "workspace-1",
        status: terminalStatus,
        completedAt: endedAt,
      };
      const active = {
        id: "active-run",
        taskId: "active-task",
        userId: "user-1",
        spaceId: "workspace-1",
        status: "running",
        completedAt: null as Date | null,
      };
      const runs = [finished, active];
      const updateRuns = vi.fn(async ({ where, data }) => {
        const matched = runs.filter(
          (run) =>
            where.id.in.includes(run.id) && (!where.status || where.status.in.includes(run.status)),
        );
        for (const run of matched) Object.assign(run, data);
        return matched.map(({ id }) => ({ id }));
      });
      const updateTask = vi.fn().mockResolvedValue({ count: 1 });
      const updateAttempt = vi.fn().mockResolvedValue({ count: 1 });
      const clearCheckpoints = vi.fn().mockResolvedValue({ count: 1 });
      const tx = {
        run: {
          updateMany: updateRuns,
          updateManyAndReturn: updateRuns,
          findMany: vi.fn(async ({ where }) => runs.filter((run) => where.id.in.includes(run.id))),
        },
        task: { updateMany: updateTask },
        attempt: { updateMany: updateAttempt },
        externalEffect: { deleteMany: clearCheckpoints },
        message: { findMany: vi.fn().mockResolvedValue([]) },
        secret: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        routine: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        bot: { update: vi.fn().mockResolvedValue({}) },
      };
      const cancel = vi.fn().mockResolvedValue(undefined);
      const prisma = {
        computer: { findUnique: vi.fn().mockResolvedValue(null) },
        // Both runs were active when selected, but the first has ended before the transaction.
        run: {
          findMany: vi
            .fn()
            .mockResolvedValue(
              runs.map(({ id, taskId, userId, spaceId }) => ({ id, taskId, userId, spaceId })),
            ),
        },
        routine: { findMany: vi.fn().mockResolvedValue([{ id: "routine-1" }]) },
        $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      await archiveBot(
        {
          prisma,
          sandbox: {} as SandboxProvider,
          home: {} as AgentHomeStore,
          jobs: { cancel } as unknown as JobPublisher,
        },
        { id: "bot-1", spaceId: "workspace-1", userId: "user-1", name: "Scout", archivedAt: null },
        context,
      );
      expect(finished.status).toBe(terminalStatus);
      expect(finished.completedAt).toBe(endedAt);
      expect(active.status).toBe("cancelled");
      expect(updateTask).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: ["active-task"] } },
        data: { status: "cancelled" },
      });
      expect(updateAttempt).toHaveBeenCalledExactlyOnceWith({
        where: { runId: { in: ["active-run"] }, status: "running" },
        data: { status: "cancelled", finishedAt: expect.any(Date) },
      });
      expect(clearCheckpoints).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ runId: { in: ["active-run"] } }),
        }),
      );
      expect(cancel.mock.calls).toEqual([["run:active-run"], ["routine:routine-1"]]);
      expect(tx.bot.update).toHaveBeenCalled();
      expect(tx.routine.updateMany).toHaveBeenCalled();
    },
  );

  it("stops work and routines while preserving the bot", async () => {
    const updateBot = vi.fn().mockResolvedValue({});
    const disableRoutines = vi.fn().mockResolvedValue({ count: 2 });
    const groupCleanup = noGroupMemberships();
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        message: { findMany: vi.fn(async () => []) },
        ...groupCleanup,
        run: {
          updateManyAndReturn: vi
            .fn()
            .mockResolvedValue([
              { id: "run-1", taskId: "task-1", userId: "user-1", spaceId: "workspace-1" },
            ]),
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "run-1", userId: "user-1", spaceId: "workspace-1" }]),
        },
        attempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        secret: { findMany: vi.fn().mockResolvedValue([]), deleteMany: deleteSecrets },
        routine: { updateMany: disableRoutines },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        bot: { update: updateBot },
      }),
    );
    const cancel = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: {
        findUnique: vi.fn().mockResolvedValue({
          id: "bot-1",
          spaceId: "workspace-1",
          archivedAt: null,
        }),
      },
      computer: { findUnique: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "run-1", taskId: "task-1", userId: "user-1", spaceId: "workspace-1" },
          ]),
      },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await archiveBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel } as unknown as JobPublisher,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
    );

    expect(disableRoutines).toHaveBeenCalledWith({
      where: { botId: "bot-1" },
      data: { active: false, nextRunAt: null },
    });
    expect(updateBot).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { archivedAt: expect.any(Date), pinned: false },
    });
    expect(groupCleanup.$queryRaw).not.toHaveBeenCalled();
    expect(groupCleanup.chatGroup.deleteMany).not.toHaveBeenCalled();
    expect(groupCleanup.chatGroupMember.deleteMany).not.toHaveBeenCalled();
    // The archived bot's cancelled run never reads a waiting one-time answer.
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "workspace-1", kind: "run-secret:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: "run-code-spent:run-1" },
          { userId: "user-1", spaceId: "workspace-1", kind: { startsWith: "run-login:run-1:" } },
        ],
      },
    });
    expect(cancel).toHaveBeenCalledWith("run:run-1");
  });

  it("surfaces computer stop failures and leaves the provider state retryable", async () => {
    const archivedAt = new Date("2026-08-16T12:00:00.000Z");
    const updateComputer = vi.fn().mockResolvedValue({});
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        ...noGroupMemberships(),
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        bot: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    const dedicated = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "cloud",
      providerRef: "provider-1",
      state: "running",
    };
    const stop = vi.fn().mockRejectedValue(new Error("stop failed"));
    const prisma = {
      computer: {
        findUnique: vi.fn().mockResolvedValue(dedicated),
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
        update: updateComputer,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const sandbox = {
      exportWorkspace: async function* () {},
      stop,
    } as unknown as SandboxProvider;
    const home = {
      commit: vi.fn().mockResolvedValue("revision-1"),
    } as unknown as AgentHomeStore;

    await expect(
      archiveBot(
        {
          prisma,
          sandbox,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        { id: "bot-1", spaceId: "workspace-1", userId: "user-1", name: "Researcher", archivedAt },
        context,
      ),
    ).rejects.toThrow("stop failed");

    expect(stop).toHaveBeenCalledOnce();
    expect(updateComputer).not.toHaveBeenCalled();
  });

  it("stops a provider that finishes booting while the bot is archived", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const booting = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "cloud",
      providerRef: null,
      state: "booting",
    };
    const running = { ...booting, providerRef: "provider-1", state: "running" };
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        ...noGroupMemberships(),
        run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        computer: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        bot: { update: vi.fn().mockResolvedValue({}) },
      }),
    );
    const prisma = {
      computer: {
        findUnique: vi.fn().mockResolvedValueOnce(booting).mockResolvedValueOnce(running),
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
        updateMany,
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      routine: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const sandbox = {
      exportWorkspace: async function* () {},
      stop,
    } as unknown as SandboxProvider;
    const home = {
      commit: vi.fn().mockResolvedValue("revision-1"),
    } as unknown as AgentHomeStore;

    await archiveBot(
      {
        prisma,
        sandbox,
        home,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      },
      {
        id: "bot-1",
        spaceId: "workspace-1",
        userId: "user-1",
        name: "Researcher",
        archivedAt: null,
      },
      context,
    );

    expect(stop).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", state: "running", providerRef: "provider-1" },
      data: { state: "stopped" },
    });
  });

  it.each(["running", "quarantined"])(
    "archives a bot whose dedicated computer is damaged without clearing %s state",
    async (state) => {
      const stop = vi.fn().mockResolvedValue(undefined);
      const updates = {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      };
      const computer = { id: "c-1", homeKey: "bot-1", providerRef: "p-1", state };
      const tx = { ...noGroupMemberships(), run: updates, task: updates, routine: updates };
      Object.assign(tx, { computerExecutionLease: updates, computer: updates, bot: updates });
      const prisma = {
        computer: {
          findUnique: vi.fn().mockResolvedValue(computer),
          findFirst: vi
            .fn()
            .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
          ...updates,
        },
        run: { findMany: vi.fn().mockResolvedValue([]) },
        routine: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      // biome-ignore lint/correctness/useYield: the damaged computer fails before its first file
      const exportWorkspace = async function* () {
        throw new SandboxDamagedError();
      };
      const sandbox = { exportWorkspace, stop } as unknown as SandboxProvider;
      const jobs = { cancel: vi.fn() } as unknown as JobPublisher;
      const bot = { id: "bot-1", spaceId: "s-1", userId: "u-1", name: "R", archivedAt: null };

      await archiveBot({ prisma, sandbox, home: {} as AgentHomeStore, jobs }, bot, context);
      expect(updates.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "c-1", state: { notIn: ["running", "quarantined"] } },
          data: { state: "stopped" },
        }),
      );

      if (state === "running")
        expect(stop).toHaveBeenCalledWith(expect.anything(), context, { discardUnsaved: true });
      else expect(stop).not.toHaveBeenCalled();
    },
  );

  it("releases the archived bot's screen and keeps its browser profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-team-archive-"));
    try {
      const home = new LocalAgentHomeStore(root);
      const teamHome = home.pathFor("team-workspace-1");
      const profile = path.join(teamHome, ".browser-profiles", profileDirectory("child-1"));
      await mkdir(profile, { recursive: true });
      await writeFile(path.join(profile, "Cookies"), "stay");
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      const team = {
        id: "team-computer",
        homeKey: "team-workspace-1",
        kind: "docker",
        providerRef: "container-1",
        scope: "team",
      };
      const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({
          ...noGroupMemberships(),
          run: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          routine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computerExecutionLease: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          computer: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            findMany: vi.fn().mockResolvedValue([]),
          },
          bot: { update: vi.fn().mockResolvedValue({}) },
        }),
      );
      const prisma = {
        computer: {
          findUnique: vi.fn(async (query: { where: { id?: string } }) =>
            query.where.id === team.id ? team : null,
          ),
        },
        run: { findMany: vi.fn().mockResolvedValue([]) },
        routine: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: transaction,
      } as unknown as PrismaClient;

      await archiveBot(
        {
          prisma,
          sandbox: { releaseScreen } as unknown as SandboxProvider,
          home,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        {
          id: "child-1",
          spaceId: "workspace-1",
          userId: "user-1",
          name: "Scout",
          archivedAt: null,
          computerId: team.id,
        },
        { ...context, botId: "parent-1", screenLeaseId: "run-parent:4" },
      );

      expect(releaseScreen).toHaveBeenCalledWith(
        {
          id: "container-1",
          botId: "team-workspace-1",
          kind: "docker",
          providerRef: "container-1",
        },
        expect.objectContaining({ botId: "child-1" }),
      );
      const releaseContext = releaseScreen.mock.calls[0]?.[1] as AdapterContext;
      expect(releaseContext.botId).toBe("child-1");
      expect(releaseContext.screenLeaseId).toBeUndefined();
      expect(releaseContext.cancelRunWork).toBeUndefined();
      await expect(readFile(path.join(profile, "Cookies"), "utf8")).resolves.toBe("stay");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function profileDirectory(botId: string) {
  return path.posix.basename(browserProfilePathForScreen(botId));
}

function profileCookies(homeDir: string, botId: string) {
  return path.join(homeDir, ".browser-profiles", profileDirectory(botId), "Cookies");
}

async function seedProfile(homeDir: string, botId: string, cookies: string) {
  const profile = path.join(homeDir, ".browser-profiles", profileDirectory(botId));
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "Cookies"), cookies);
}

async function seedFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function runInWorkspace(cwd: string, argv: readonly string[]) {
  try {
    execFileSync(argv[0] ?? "bash", argv.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? 1, stderr: failed.stderr ?? "" };
  }
}

function deletionPrisma(team: { id: string }) {
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "bot-1" }]),
      chatGroup: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      page: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      secret: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      botDeletion: { create: vi.fn().mockResolvedValue({}) },
      bot: { delete: vi.fn().mockResolvedValue({}) },
    }),
  );
  return {
    computer: {
      findUnique: vi.fn(async (query: { where: { id?: string; scopeKey?: string } }) =>
        query.where.id === team.id || query.where.scopeKey === "team:workspace-1:user-1"
          ? team
          : null,
      ),
    },
    run: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    // The Space's owner keeps its Team Computer.
    spaceMember: { findFirst: vi.fn().mockResolvedValue({ userId: "user-1" }) },
    $transaction: transaction,
  } as unknown as PrismaClient;
}

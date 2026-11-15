import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerComputerRequest } from "../computer-control.js";
import type { RouterDeps } from "../router.js";
import { purgeClearedThreadMemory } from "../thread-memory.js";
import type { ThreadTarget } from "../thread-target.js";
import { takeoverReleaser } from "./threads.js";

vi.mock("../computer-control.js", () => ({
  answerComputerRequest: vi.fn().mockResolvedValue(null),
}));

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

describe("takeoverReleaser", () => {
  const findUnique = vi.fn();
  const deps = { prisma: { run: { findUnique } } } as unknown as RouterDeps;

  beforeEach(() => {
    findUnique.mockReset();
    vi.mocked(answerComputerRequest).mockClear();
  });

  it("hands the screen back to the bot of a direct chat", async () => {
    const target = { kind: "bot", botId: "bot-1" } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-1");
    expect(answerComputerRequest).toHaveBeenCalledWith(deps, actor, "bot-1", "done", "run-1");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("hands the screen back to the group member whose run the reply steers", async () => {
    findUnique.mockResolvedValue({ botId: "bot-2" });
    const target = { kind: "group", memberBotIds: ["bot-1", "bot-2"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-2");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-2", spaceId: "space-1" },
      select: { botId: true },
    });
    expect(answerComputerRequest).toHaveBeenCalledWith(deps, actor, "bot-2", "done", "run-2");
  });

  it("still steers when the bot waits for someone else", async () => {
    vi.mocked(answerComputerRequest).mockRejectedValueOnce(new ORPCError("CONFLICT"));
    const target = { kind: "bot", botId: "bot-1" } as ThreadTarget;
    await expect(takeoverReleaser(deps, actor, target)("run-1")).resolves.toBeUndefined();
  });

  it("releases nothing when the run is gone", async () => {
    findUnique.mockResolvedValue(null);
    const target = { kind: "group", memberBotIds: ["bot-1"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-3");
    expect(answerComputerRequest).not.toHaveBeenCalled();
  });
});

describe("purgeClearedThreadMemory", () => {
  const findMany = vi.fn();
  const purgeHistory = vi.fn();
  const depsWith = (provider: object) =>
    ({
      jobs: { enqueue: vi.fn(async () => undefined) },
      prisma: { run: { findMany } },
      memoryProviders: { resolve: vi.fn().mockResolvedValue({ provider }) },
    }) as unknown as RouterDeps;
  const byThread = {
    purgeHistory,
    describe: () => ({ capabilities: { purgesByThread: true } }),
  };
  const group = {
    kind: "group",
    threadId: "thread-1",
    memberBotIds: ["bot-1", "bot-2"],
  } as ThreadTarget;

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([{ botId: "bot-2" }, { botId: "bot-3" }]);
    purgeHistory.mockReset().mockResolvedValue({ ok: true });
  });

  it("purges current and removed members of a group even with learning off", async () => {
    await purgeClearedThreadMemory(depsWith(byThread), actor, group, 3);
    expect(findMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      distinct: ["botId"],
      select: { botId: true },
    });
    expect(purgeHistory.mock.calls.map(([request]) => request.botId).sort()).toEqual([
      "bot-1",
      "bot-2",
      "bot-3",
    ]);
    for (const [request] of purgeHistory.mock.calls) {
      expect(request).toMatchObject({ threadId: "thread-1", generations: [2, 3] });
    }
  });

  it("purges nothing for a group when the provider does not purge by thread", async () => {
    await purgeClearedThreadMemory(
      depsWith({
        purgeHistory,
        retainConversation: vi.fn(),
        describe: () => ({ capabilities: {} }),
      }),
      actor,
      group,
      3,
    );
    expect(purgeHistory).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "limits a departing group member's cleanup to that bot (byThread=%s)",
    async (byThread) => {
      await purgeClearedThreadMemory(
        depsWith({
          purgeHistory,
          describe: () => ({ capabilities: { purgesByThread: byThread } }),
        }),
        actor,
        { kind: "group-member", botId: "departing-bot", threadId: "group-thread" },
        3,
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(purgeHistory.mock.calls.map(([request]) => request)).toEqual(
        byThread ? [{ botId: "departing-bot", threadId: "group-thread", generations: [2, 3] }] : [],
      );
    },
  );

  it("purges the bot of a direct chat without learned turns", async () => {
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-2" } as ThreadTarget;
    await purgeClearedThreadMemory(depsWith({ purgeHistory }), actor, target, 0);
    expect(purgeHistory).toHaveBeenCalledTimes(1);
    expect(purgeHistory.mock.calls[0]?.[0]).toEqual({
      botId: "bot-1",
      threadId: "thread-2",
      generations: [0, 0],
    });
  });

  it("keeps purging the other bots when one purge fails", async () => {
    purgeHistory.mockImplementation(async ({ botId }: { botId: string }) => {
      if (botId === "bot-1") return { ok: false, error: "nope" };
      if (botId === "bot-2") throw new Error("boom");
      return { ok: true };
    });
    await expect(
      purgeClearedThreadMemory(depsWith(byThread), actor, group, 1),
    ).resolves.toBeUndefined();
    expect(purgeHistory).toHaveBeenCalledTimes(3);
  });

  it("still purges the current members when the bots that ran there can't be listed", async () => {
    findMany.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      purgeClearedThreadMemory(depsWith(byThread), actor, group, 1),
    ).resolves.toBeUndefined();
    expect(purgeHistory.mock.calls.map(([request]) => request.botId).sort()).toEqual([
      "bot-1",
      "bot-2",
    ]);
  });

  it("queues failed purges with the original connection and cleared generations", async () => {
    const deps = depsWith({ ...byThread, connectionIdentity: "connection-1" });
    purgeHistory.mockResolvedValueOnce({ ok: false, error: "cleanup deadline" });
    await purgeClearedThreadMemory(deps, actor, group, 3);
    expect(deps.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "memory.purge-history",
        maxAttempts: 12,
        payload: {
          ...actor,
          botId: "bot-1",
          threadId: "thread-1",
          generations: [2, 3],
          connectionIdentity: "connection-1",
        },
      }),
    );
  });
});

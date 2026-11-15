import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "test@example.test",
  isDeploymentOwner: false,
};

function fixture(activeIds: string[]) {
  const owned = ["a", "b", "c"].map((id) => ({ id, name: id, color: "gray" }));
  const record = {
    id: "group-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name: "Team",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    thread: { id: "thread-1", reads: [{ unread: false }], messages: [] },
    members: owned.map((bot) => ({ bot: { ...bot, runs: [] } })),
  };
  const lock = vi.fn().mockResolvedValue([{ id: "group-1" }]);
  const write = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue({ count: 2 });
  const create = vi.fn().mockResolvedValue({ count: 3 });
  const read = vi.fn(async () => {
    expect(lock).toHaveBeenCalledOnce();
    return {
      thread: record.thread,
      members: activeIds.map((botId) => ({ botId, bot: { archivedAt: null } })),
    };
  });
  const tx = {
    $queryRaw: lock,
    chatGroup: {
      findFirst: read,
      update: write,
      findFirstOrThrow: vi.fn().mockResolvedValue(record),
    },
    chatGroupMember: { deleteMany: remove, createMany: create },
    message: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue(owned) },
    $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
  };
  return { repos: createGroupRepos(prisma as unknown as PrismaClient), write, remove, create };
}

describe("membership replacement precondition", () => {
  it("checks under the existing group lock and preserves a concurrently added member", async () => {
    const f = fixture(["a", "b", "other"]);
    await expect(
      f.repos.updateGroup(actor, {
        groupId: "group-1",
        botIds: ["a", "b", "c"],
        expectedBotIds: ["a", "b"],
      }),
    ).rejects.toThrow("Group members changed");
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("refuses a stale roster even when its length is unchanged", async () => {
    const f = fixture(["a", "other"]);
    await expect(
      f.repos.updateGroup(actor, {
        groupId: "group-1",
        botIds: ["a", "b", "c"],
        expectedBotIds: ["a", "b"],
      }),
    ).rejects.toThrow("Group members changed");
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("accepts an unchanged set regardless of the client's member order", async () => {
    const f = fixture(["a", "b"]);
    const result = await f.repos.updateGroup(actor, {
      groupId: "group-1",
      botIds: ["a", "b", "c"],
      expectedBotIds: ["b", "a"],
    });
    expect(result.group.members.map((member) => member.botId)).toEqual(["a", "b", "c"]);
    expect(result.cancelledRunIds).toEqual([]);
    expect(f.create).toHaveBeenCalledOnce();
  });
});

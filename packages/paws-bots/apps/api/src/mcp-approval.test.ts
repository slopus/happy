import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  dismissMcpServerApprovals,
  queueMcpConnectedRun,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "./mcp-approval.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

/** PostgreSQL jsonb `@>` containment, which Prisma `array_contains` compiles to. */
function jsonContains(value: unknown, needle: unknown): boolean {
  if (Array.isArray(needle)) {
    return (
      Array.isArray(value) &&
      needle.every((item) => value.some((candidate) => jsonContains(candidate, item)))
    );
  }
  if (needle !== null && typeof needle === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.entries(needle).every(([key, item]) => jsonContains(record[key], item));
  }
  return value === needle;
}

type MessageQuery = { where?: { blocks?: { array_contains?: unknown } } };

function fixture(blocks: unknown[]) {
  const tx = {
    message: {
      findMany: vi.fn(
        async (_query: MessageQuery): Promise<unknown[]> => [
          { id: "card-message", botId: "bot", blocks },
        ],
      ),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "main-thread" } })) },
      thread: { findMany: vi.fn(async () => [{ id: "group-thread" }]) },
      mcpServer: { findFirst: vi.fn(async () => ({ id: "srv-a" })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof resolveMcpApprovalCards>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}

describe("resolveMcpApprovalCards", () => {
  it("flips pending and pre-upgrade cards for the matching server", async () => {
    const blocks = [
      { kind: "text", text: "before" },
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "Legacy", serverId: "srv-a" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
      threadId: "group-thread",
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          blocks[0],
          { ...blocks[1], status: "connected" },
          { ...blocks[2], status: "connected" },
          blocks[3],
          blocks[4],
        ],
      },
    });
  });

  it("scans the requested chat when a threadId is given", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "group-thread",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledWith({
      where: {
        id: "group-thread",
        spaceId: "space",
        OR: [{ botId: "bot" }, { group: { members: { some: { botId: "bot" } } } }],
      },
      select: { id: true, botId: true },
    });
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: "group-thread" } }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "dismissed" }] },
    });
  });

  it("falls back to owner scope for chats the bot was removed from", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    deps.prisma.thread.findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "group-thread" }]);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
      threadId: "group-thread",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledTimes(2);
    expect(deps.prisma.thread.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "group-thread",
        spaceId: "space",
        groupId: { not: null },
      },
      select: { id: true, botId: true },
    });
    expect(deps.prisma.bot.findFirst).toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("leaves untouched messages alone when nothing matches", async () => {
    const blocks = [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("writes the assignment in the same transaction when a card connects", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        { botId: "bot", serverId: "srv-a", status: "connected" },
        effect,
      ),
    ).resolves.toBe("saved");
    expect(effect).toHaveBeenCalledWith(tx, { assign: true, resolved: true });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("does not assign when a dismissed card already won", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "dismissed" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      { botId: "bot", serverId: "srv-a", status: "connected", threadId: "group-thread" },
      effect,
    );
    expect(effect).toHaveBeenCalledWith(tx, { assign: false, resolved: false });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("still assigns from settings after a card was dismissed", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "dismissed" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        { botId: "bot", serverId: "srv-a", status: "connected" },
        effect,
      ),
    ).resolves.toBe("saved");
    expect(effect).toHaveBeenCalledWith(tx, { assign: true, resolved: true });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("returns a connected card to pending when the assignment is removed", async () => {
    const blocks = [
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "connected" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await revertConnectedMcpApprovals(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "pending",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        OR: [{ botId: "bot" }, { groupId: { not: null }, messages: { some: { botId: "bot" } } }],
      },
      select: { id: true, botId: true },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [{ ...blocks[0], status: "pending" }, blocks[1], blocks[2]],
      },
    });
  });

  it("dismisses connected and pending cards when the server is deleted", async () => {
    const blocks = [
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" },
      { kind: "mcp_approval", name: "Open", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const rows = [
      {
        id: "card-message",
        botId: null,
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks,
      },
      {
        id: "mention",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "text", text: "server srv-a is gone" }],
      },
      {
        id: "other-server",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "connected" }],
      },
    ];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockImplementation(async (query) => {
      const needle = query.where?.blocks?.array_contains;
      if (needle === undefined) return [];
      return rows.filter((row) => jsonContains(row.blocks, needle));
    });
    await dismissMcpServerApprovals(deps, actor, "srv-a");
    expect(deps.prisma.thread.findMany).not.toHaveBeenCalled();
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: {
        thread: { spaceId: "space" },
        blocks: { array_contains: [{ kind: "mcp_approval", serverId: "srv-a" }] },
      },
      select: {
        id: true,
        botId: true,
        blocks: true,
        threadId: true,
        thread: { select: { botId: true } },
      },
    });
    expect(tx.message.update).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          { ...blocks[0], status: "dismissed" },
          { ...blocks[1], status: "dismissed" },
          blocks[2],
        ],
      },
    });
  });

  it("does not reset another bot's card in a shared group", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" }];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockResolvedValue([{ id: "card-message", botId: "other-bot", blocks }]);
    await revertConnectedMcpApprovals(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "pending",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("does not repaint another bot's direct chat when the bot has left", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    vi.mocked(deps.prisma.thread.findMany).mockResolvedValue([]);
    vi.mocked(deps.prisma.bot.findFirst).mockResolvedValue(null);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "other-thread",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("leaves a card for another member's server to that member", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    deps.prisma.mcpServer.findFirst = vi.fn(async () => null) as never;
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "group-thread",
    });
    expect(deps.prisma.mcpServer.findFirst).toHaveBeenCalledWith({
      where: {
        id: "srv-a",
        userId: "user",
        OR: [
          { spaceId: "space" },
          { allSpaces: true },
          { availableIn: { some: { spaceId: "space" } } },
        ],
      },
      select: { id: true },
    });
    expect(deps.prisma.thread.findMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});

describe("queueMcpConnectedRun", () => {
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  const input = { botId: "bot", serverId: "srv-a", threadId: "thread" };

  function connectedFixture(state: { thread?: boolean; busy?: boolean; archived?: boolean } = {}) {
    const tx = {
      bot: { findFirst: vi.fn(async () => (state.archived ? null : { id: "bot" })) },
      thread: { findFirst: vi.fn(async () => (state.thread === false ? null : { id: "thread" })) },
      run: {
        findFirst: vi.fn(async () => (state.busy ? { id: "active" } : null)),
        create: vi.fn(async () => ({ id: "run" })),
      },
      mcpServer: { findFirst: vi.fn(async () => ({ name: "Axiom" })) },
      task: { create: vi.fn(async () => ({ id: "task" })) },
    };
    return tx as typeof tx & Parameters<typeof queueMcpConnectedRun>[0];
  }

  it("queues a turn for the bot in the card's chat", async () => {
    const tx = connectedFixture();
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBe("run");
    expect(tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "bot",
        threadId: "thread",
        prompt: expect.stringContaining('"Axiom"'),
      }),
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: "task", trigger: "user", status: "queued" }),
      select: { id: true },
    });
  });

  it("does not queue while the bot is still busy in that chat", async () => {
    const tx = connectedFixture({ busy: true });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("does not restart an archived bot", async () => {
    const tx = connectedFixture({ archived: true });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.bot.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "bot", archivedAt: null }),
      select: { id: true },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it("does not queue in a chat the bot is not part of", async () => {
    const tx = connectedFixture({ thread: false });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.task.create).not.toHaveBeenCalled();
  });
});

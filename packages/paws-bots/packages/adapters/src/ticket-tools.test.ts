import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "./ticket-tools.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: "board-1",
    spaceId: "ws",
    name: "Personal",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function boardSpace() {
  const row = board();
  return {
    board: {
      findUnique: vi.fn(async () => row),
      createMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    space: { findUnique: vi.fn(async () => ({ name: "Personal" })) },
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    boardId: "board-1",
    spaceId: "ws",
    number: 1,
    title: "Ticket",
    description: null,
    status: "todo",
    priority: null,
    assigneeBotId: "bot-1",
    createdByBotId: null,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe("ticket tools", () => {
  it("lists tickets strictly within the space and board", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 1, status: "doing" })]);
    const prisma = {
      ...boardSpace(),
      ticket: { findMany },
    };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      status: "doing",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws", boardId: "board-1", status: "doing" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    expect(result).toEqual({ tickets: [expect.objectContaining({ ref: "RAK-1" })] });
  });

  it("leaves closed tickets out of an unfiltered list and shortens descriptions", async () => {
    const findMany = vi.fn(async () => [ticket({ number: 2, description: "x".repeat(500) })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws", boardId: "board-1", status: { not: "closed" } },
        take: 51,
      }),
    );
    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toHaveLength(200);
    expect(listed.description.endsWith("…")).toBe(true);
  });

  it("does not split an emoji when it shortens a description", async () => {
    const description = `${"x".repeat(198)}😀tail`;
    const findMany = vi.fn(async () => [ticket({ number: 2, description })]);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const result = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });

    const listed = (result as { tickets: { description: string }[] }).tickets[0]!;
    expect(listed.description).toBe(`${"x".repeat(198)}…`);
  });

  it("pages older tickets with a cursor and rejects a bad one", async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      ticket({
        id: `t${String(index).padStart(2, "0")}`,
        number: index + 1,
        createdAt: new Date(NOW.getTime() - index * 1000),
      }),
    );
    const findMany = vi.fn(async (_query: unknown) => rows);
    const prisma = { ...boardSpace(), ticket: { findMany } };

    const first = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
    });
    expect(first).toEqual({
      tickets: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const page = first as { tickets: { id: string }[]; nextCursor: string };
    expect(page.tickets).toHaveLength(50);
    expect(page.tickets[49]?.id).toBe("t49");

    await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      cursor: page.nextCursor,
    });
    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: {
        spaceId: "ws",
        boardId: "board-1",
        status: { not: "closed" },
        OR: [
          { createdAt: { lt: rows[49]!.createdAt } },
          { createdAt: rows[49]!.createdAt, id: { lt: "t49" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });

    const invalid = await listBoardTickets({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: "ws",
      cursor: "not-a-cursor",
    });
    expect(invalid).toEqual({ error: "cursor is invalid." });
  });
});

function mutationDeps(ticketBoardEnabled = true) {
  let current = ticket();
  const changes = vi.fn(async (_change: { wakeAssignee: boolean }) => {});
  const tx = {
    board: { update: vi.fn(async () => ({ nextNumber: 2 })) },
    ticket: {
      findFirst: vi.fn(async () => current),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = ticket(data);
        return current;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
        return current;
      }),
    },
    ticketComment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "comment-1",
        createdAt: NOW,
        updatedAt: NOW,
        authorBot: { name: "Planner" },
        authorUser: null,
        ...data,
      })),
    },
    $queryRaw: vi.fn(async () => []),
  };
  const prisma = {
    ...boardSpace(),
    bot: { findFirst: vi.fn(async () => ({ id: "bot-2" })) },
    ticket: tx.ticket,
    ticketComment: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    deps: { prisma, onTicketChange: changes, ticketBoardEnabled } as never,
    prisma,
    tx,
    changes,
  };
}

describe("ticket mutations", () => {
  it.each([
    ["create", "title", TICKET_TITLE_MAX_LENGTH],
    ["create", "description", TICKET_DESCRIPTION_MAX_LENGTH],
    ["update", "title", TICKET_TITLE_MAX_LENGTH],
    ["update", "description", TICKET_DESCRIPTION_MAX_LENGTH],
    ["comment", "body", TICKET_COMMENT_MAX_LENGTH],
  ] as const)(
    "explains an oversized %s %s before database access",
    async (operation, field, limit) => {
      const s = mutationDeps();
      const value = "x".repeat(limit + 1);
      const input = { spaceId: "ws", userId: "user-1", botId: "bot-1", id: "t1" };
      const result =
        operation === "create"
          ? await createTicket(s.deps, { ...input, title: "Ship", [field]: value })
          : operation === "update"
            ? await updateTicket(s.deps, { ...input, [field]: value })
            : await commentTicket(s.deps, { ...input, body: value });

      expect(result).toHaveProperty("error", expect.stringContaining(field));
      expect(result).toHaveProperty("error", expect.stringContaining(String(limit)));
      expect(result).toHaveProperty("error", expect.not.stringContaining(value));
      expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
      expect(s.prisma.bot.findFirst).not.toHaveBeenCalled();
      expect(s.prisma.$transaction).not.toHaveBeenCalled();
      expect(s.changes).not.toHaveBeenCalled();
    },
  );

  it("preserves complete values at the existing length limits", async () => {
    const s = mutationDeps();
    const title = "x".repeat(TICKET_TITLE_MAX_LENGTH);
    const description = "x".repeat(TICKET_DESCRIPTION_MAX_LENGTH);
    const body = "x".repeat(TICKET_COMMENT_MAX_LENGTH);
    const input = { spaceId: "ws", userId: "user-1", botId: "bot-1", id: "t1" };

    await expect(
      createTicket(s.deps, { ...input, title: ` ${title} `, description }),
    ).resolves.toHaveProperty("ticket.title", title);
    expect(s.tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title, description }) }),
    );
    await expect(
      updateTicket(s.deps, { ...input, title: ` ${title} `, description }),
    ).resolves.toHaveProperty("ticket.description", description);
    expect(s.tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title, description }) }),
    );
    await expect(commentTicket(s.deps, { ...input, body: ` ${body} ` })).resolves.toHaveProperty(
      "comment.body",
      body,
    );
    expect(s.tx.ticketComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body }) }),
    );
  });

  it.each([
    ["title", " "],
    ["priority", "invalid-marker"],
    ["status", "invalid-marker"],
  ])("keeps invalid %s updates rejected with field-level feedback", async (field, value) => {
    const s = mutationDeps();
    const result = await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      [field]: value,
    });
    expect(result).toHaveProperty("error", expect.stringContaining(field));
    expect(result).toHaveProperty("error", expect.not.stringContaining("invalid-marker"));
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("uses public parameter names and keeps blank comments rejected", async () => {
    const s = mutationDeps();
    await expect(
      createTicket(s.deps, { spaceId: "ws", userId: "user-1", title: "Ship" }),
    ).resolves.toHaveProperty("error", expect.stringContaining("ownerBotId"));
    const result = await commentTicket(s.deps, { spaceId: "ws", id: "", body: " " });
    expect(result).toHaveProperty("error", expect.stringContaining("id:"));
    expect(result).toHaveProperty("error", expect.stringContaining("body:"));
    expect(result).toHaveProperty("error", expect.not.stringContaining("ticketId"));
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("disables every tool without database access or wake-ups", async () => {
    const s = mutationDeps(false);
    await createTicket(s.deps, { spaceId: "ws", userId: "user-1", botId: "bot-1", title: "Ship" });
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      botId: "bot-1",
      id: "t1",
      ownerBotId: "bot-2",
    });
    await commentTicket(s.deps, { spaceId: "ws", botId: "bot-1", id: "t1", body: "Ready" });
    await listBoardTickets(s.deps, { spaceId: "ws" });
    await getTicket(s.deps, { spaceId: "ws", ref: "RAK-1" });
    expect(s.prisma.board.findUnique).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });
  it("allocates a number and wakes the assigned bot once", async () => {
    const s = mutationDeps();
    const result = await createTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      userId: "user-1",
      title: "  Ship  ",
      ownerBotId: "bot-2",
    });
    expect(result).toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1", title: "Ship", assigneeBotId: "bot-2" }),
    });
    expect(s.tx.board.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextNumber: { increment: 1 } } }),
    );
    expect(s.changes).toHaveBeenCalledOnce();
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: true }));
  });
  it("wakes on an actual reassignment once, and never on status edits or repeated assignment", async () => {
    const s = mutationDeps();
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      status: "doing",
    });
    expect(s.changes).toHaveBeenCalledWith(
      expect.objectContaining({ wakeAssignee: true, assigneeBotId: "bot-2" }),
    );
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      status: "done",
    });
    expect(
      s.changes.mock.calls.map(([value]) => (value as { wakeAssignee: boolean }).wakeAssignee),
    ).toEqual([true, false]);
    expect(s.tx.ticket.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "done", completedAt: expect.any(Date) }),
      }),
    );
  });
  it("does not wake a bot creating or assigning a ticket to itself", async () => {
    const s = mutationDeps();
    await createTicket(s.deps, { spaceId: "ws", userId: "user-1", botId: "bot-1", title: "Ship" });
    await updateTicket(s.deps, {
      spaceId: "ws",
      userId: "user-1",
      id: "t1",
      ownerBotId: "bot-2",
      botId: "bot-2",
    });
    expect(s.changes.mock.calls.map(([value]) => value.wakeAssignee)).toEqual([false, false]);
  });
  it("comments without waking the owner", async () => {
    const s = mutationDeps();
    const result = await commentTicket(s.deps, {
      spaceId: "ws",
      botId: "bot-1",
      id: "t1",
      body: " Ready ",
    });
    expect(result).toHaveProperty("comment.authorName", "Planner");
    expect(s.tx.ticketComment.create).toHaveBeenCalledWith({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: expect.objectContaining({ body: "Ready", ticketId: "t1" }),
    });
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });
  it("reads tickets with their comments", async () => {
    const s = mutationDeps();
    await expect(getTicket(s.deps, { spaceId: "ws", ref: "RAK-1" })).resolves.toEqual({
      ticket: expect.objectContaining({ ref: "RAK-1" }),
      comments: [],
    });
    expect(s.prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { number: 1, spaceId: "ws", boardId: "board-1" },
    });
  });
  it("only assigns the acting user's own bots", async () => {
    const s = mutationDeps();
    s.prisma.bot.findFirst.mockResolvedValue(null as never);
    await expect(
      createTicket(s.deps, {
        spaceId: "ws",
        botId: "bot-1",
        userId: "user-1",
        title: "Ship",
        ownerBotId: "other-members-bot",
      }),
    ).resolves.toEqual({ error: "Unknown bot." });
    await expect(
      updateTicket(s.deps, {
        spaceId: "ws",
        userId: "user-1",
        id: "t1",
        ownerBotId: "other-members-bot",
      }),
    ).resolves.toEqual({ error: "Unknown bot." });
    for (const [query] of s.prisma.bot.findFirst.mock.calls as unknown as [unknown][]) {
      expect(query).toEqual({
        where: { id: "other-members-bot", spaceId: "ws", userId: "user-1", archivedAt: null },
        select: { id: true },
      });
    }
    expect(s.prisma.bot.findFirst).toHaveBeenCalledTimes(2);
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });
  it("rejects invalid input and foreign owners before a write", async () => {
    const s = mutationDeps();
    await expect(
      createTicket(s.deps, { spaceId: "ws", userId: "user-1", botId: "bot-1", title: " " }),
    ).resolves.toHaveProperty("error");
    s.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      updateTicket(s.deps, { spaceId: "ws", userId: "user-1", id: "t1", ownerBotId: "foreign" }),
    ).resolves.toHaveProperty("error");
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard, listTicketComments, toTicketCommentDto } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("board creation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `board-organization-${suffix}`;
  const spaceId = `board-space-${suffix}`;
  const userId = `board-user-${suffix}`;
  const tenant = { spaceId, userId };
  let prisma: PrismaClient;
  let fixtures: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    fixtures = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await fixtures.user.create({
      data: {
        id: userId,
        name: "Board tester",
        email: `${userId}@example.test`,
      },
    });
    await fixtures.organization.create({
      data: {
        id: organizationId,
        name: "Board Org",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await fixtures.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await fixtures.organization.deleteMany({ where: { id: organizationId } });
    await fixtures.user.delete({ where: { id: userId } });
    await close();
  });
  it("allows concurrent first opens and returns the same board", async () => {
    const boards = await Promise.all(
      Array.from({ length: 8 }, () => runAsTenant(tenant, () => ensureBoard(prisma, spaceId))),
    );
    expect(new Set(boards.map((board) => board.id)).size).toBe(1);
    expect(boards.every((board) => board.name === "General")).toBe(true);
    expect(await fixtures.board.count({ where: { spaceId } })).toBe(1);
  });
  it("returns user and bot display names with comments", async () => {
    const board = await runAsTenant(tenant, () => ensureBoard(prisma, spaceId));
    const bot = await fixtures.bot.create({
      data: { spaceId, userId, name: "Planner", color: "blue" },
    });
    const ticket = await fixtures.ticket.create({
      data: { spaceId, boardId: board.id, number: 1, title: "Ship" },
    });
    await fixtures.ticketComment.createMany({
      data: [
        { ticketId: ticket.id, spaceId, authorUserId: userId, body: "Ready" },
        { ticketId: ticket.id, spaceId, authorBotId: bot.id, body: "Reviewed" },
      ],
    });
    const rows = await runAsTenant(tenant, () => listTicketComments(prisma, spaceId, ticket.id));
    const comments = rows.map(toTicketCommentDto);
    expect(comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Ready", authorName: "Board tester" }),
        expect.objectContaining({ body: "Reviewed", authorName: "Planner" }),
      ]),
    );
  });
});

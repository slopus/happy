import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createOrganizationForUser } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { otherSpaceOfBot } from "./bot-space.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("the Space of a linked bot (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let sequence = 0;

  async function signup(): Promise<Actor> {
    const userId = `bot-space-${++sequence}-${suffix}`;
    users.push(userId);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  const bot = (spaceId: string, userId: string) =>
    system.bot.create({ data: { spaceId, userId, name: "Scout", color: "blue" } });

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("finds the caller's bot in another organization and never another person's", async () => {
    const ada = await signup();
    const grace = await signup();
    const work = await createOrganizationForUser(system, { userId: ada.userId, name: "Work" });
    const adaWorkBot = await bot(work.defaultSpaceId, ada.userId);
    const adaHomeBot = await bot(ada.spaceId, ada.userId);
    const graceBot = await bot(grace.spaceId, grace.userId);

    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBe(work.defaultSpaceId);
    await expect(otherSpaceOfBot(prisma, ada, adaHomeBot.id)).resolves.toBeUndefined();
    await expect(otherSpaceOfBot(prisma, ada, graceBot.id)).resolves.toBeUndefined();

    await system.bot.update({ where: { id: adaWorkBot.id }, data: { archivedAt: new Date() } });
    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBeUndefined();
    await system.bot.update({ where: { id: adaWorkBot.id }, data: { archivedAt: null } });
    await system.space.update({
      where: { id: work.defaultSpaceId },
      data: { deletingAt: new Date() },
    });
    await expect(otherSpaceOfBot(prisma, ada, adaWorkBot.id)).resolves.toBeUndefined();
  });
});

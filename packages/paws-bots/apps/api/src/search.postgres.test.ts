import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { querySpaceSearch } from "./search.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("space search with CONTENT_ENCRYPTION on and off (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `search-switch-user-${suffix}`;
  const organizationId = `search-switch-org-${suffix}`;
  const spaceId = `search-switch-space-${suffix}`;
  const botId = `search-switch-bot-${suffix}`;
  const threadId = `search-switch-thread-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let on: ReturnType<typeof createDb>;
  let off: ReturnType<typeof createDb>;

  const system = <T>(work: () => Promise<T>) => runAsSystem("test fixture", work);
  const say = (prisma: PrismaClient, text: string) =>
    createThreadMessage(prisma, { threadId, role: "bot", botId, blocks: [{ kind: "text", text }] });
  const snippets = async (prisma: PrismaClient, query: string) =>
    (await querySpaceSearch(prisma, actor, query))
      .filter((hit) => hit.kind === "message")
      .map((hit) => hit.snippet)
      .sort();

  beforeAll(() =>
    system(async () => {
      on = createDb(databaseUrl!, { encryptContent: true });
      off = createDb(databaseUrl!, { encryptContent: false });
      const prisma = on.prisma;
      await prisma.user.create({
        data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Search", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    }),
  );

  afterAll(async () => {
    await on?.prisma.organization.deleteMany({ where: { id: organizationId } });
    await on?.prisma.user.deleteMany({ where: { id: userId } });
    for (const db of [on, off]) {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }
  });

  it("finds plaintext, encrypted and mixed messages in both modes", () =>
    system(async () => {
      // Off from the start: no keys, plain substring search, including inside words.
      const plain = await say(off.prisma, "the capybara plan");
      expect(await snippets(off.prisma, "capybara")).toEqual(["the capybara plan"]);
      expect(await snippets(off.prisma, "apyba")).toEqual(["the capybara plan"]);

      // Mixed: an encrypted message beside the plaintext one.
      await say(on.prisma, "the capybara budget");
      const both = ["the capybara budget", "the capybara plan"];
      for (const db of [on, off]) expect(await snippets(db.prisma, "capybara")).toEqual(both);

      // All encrypted: rewriting the plaintext row with encryption on seals it, as
      // `content-encryption migrate` does row by row.
      await on.prisma.message.update({
        where: { id: plain.id },
        data: { blocks: [{ kind: "text", text: "the capybara plan" }] },
        select: { id: true },
      });
      for (const db of [on, off]) expect(await snippets(db.prisma, "capybara")).toEqual(both);

      // Rewritten with encryption off again, it is found by its new text only.
      await off.prisma.message.update({
        where: { id: plain.id },
        data: { blocks: [{ kind: "text", text: "the capybara roadmap" }] },
        select: { id: true },
      });
      for (const db of [on, off]) {
        expect(await snippets(db.prisma, "capybara")).toEqual([
          "the capybara budget",
          "the capybara roadmap",
        ]);
        expect(await snippets(db.prisma, "plan")).toEqual([]);
      }
    }));

  it("never returns a delivery, plaintext or encrypted", () =>
    system(async () => {
      for (const db of [off, on]) {
        await createThreadMessage(db.prisma, {
          threadId,
          role: "user",
          blocks: [{ kind: "delivery" }, { kind: "text", text: "wombat lead payload" }],
        });
      }
      await say(on.prisma, "the wombat summary");
      for (const db of [on, off]) {
        expect(await snippets(db.prisma, "wombat")).toEqual(["the wombat summary"]);
      }
    }));
});

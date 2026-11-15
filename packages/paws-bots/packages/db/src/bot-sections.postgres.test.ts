import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { BotSectionNameConflictError, IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("deleteBotSection (PostgreSQL)", () => {
  const provider = "sendblue";
  const stamp = String(Date.now()).slice(-7);
  const ownerAddress = `+1555${stamp}`;
  const strangerAddress = `+1556${stamp}`;
  const neighborId = `section-neighbor-${stamp}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let stranger: { userId: string; spaceId: string };

  const actorFor = (identity: { userId: string; spaceId: string }) => ({
    userId: identity.userId,
    spaceId: identity.spaceId,
    email: "sections@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  const signup = { signupsEnabled: undefined, signupAllowlist: undefined };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const system = asSystem(prisma);
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address: ownerAddress }, signup),
    );
    stranger = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider, address: strangerAddress }, signup),
    );
    await system.user.create({
      data: {
        id: neighborId,
        name: "Section Neighbor",
        email: `${neighborId}@rakazo.test`,
        emailVerified: false,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({
        where: { provider, address: { in: [ownerAddress, strangerAddress] } },
      });
      const spaceIds = [owner?.spaceId, stranger?.spaceId].filter(Boolean) as string[];
      const userIds = [owner?.userId, stranger?.userId, neighborId].filter(Boolean) as string[];
      await system.organization.deleteMany({ where: { id: { in: spaceIds } } });
      await system.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await close?.();
  });

  it("deletes the section and keeps its bots and groups, now unsectioned", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const actor = actorFor(owner);
    const { first, group, section } = await runAsTenant(owner, async () => {
      const first = await repos.createBot(actor, botInput("First"));
      const second = await repos.createBot(actor, botInput("Second"));
      const group = await createGroupRepos(prisma).createGroup(actor, {
        name: "Pair",
        botIds: [first.id, second.id],
      });
      const section = await repos.createBotSection(actor, { botId: first.id, name: "Doomed" });
      return { first, group, section };
    });
    await system.chatGroup.update({ where: { id: group.id }, data: { sectionId: section.id } });

    await expect(
      runAsTenant(owner, () => repos.deleteBotSection(actor, { sectionId: section.id })),
    ).resolves.toEqual({
      id: section.id,
      releasedBots: 1,
      releasedGroups: 1,
    });

    expect(await system.botSection.findUnique({ where: { id: section.id } })).toBeNull();
    const [bot, chatGroup] = await Promise.all([
      system.bot.findUniqueOrThrow({ where: { id: first.id } }),
      system.chatGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ]);
    expect(bot.sectionId).toBeNull();
    expect(bot.archivedAt).toBeNull();
    expect(chatGroup.sectionId).toBeNull();
    expect(chatGroup.archivedAt).toBeNull();
  });

  it("lets any member of the space delete a section another member made", async () => {
    const system = asSystem(prisma);
    const neighborSection = await system.botSection.create({
      data: { spaceId: owner.spaceId, userId: neighborId, name: "Theirs" },
    });

    await runAsTenant(owner, () =>
      createRepos(prisma).deleteBotSection(actorFor(owner), { sectionId: neighborSection.id }),
    );
    expect(await system.botSection.findUnique({ where: { id: neighborSection.id } })).toBeNull();
  });

  it("files into another member's same-named section instead of making a second one", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const actor = actorFor(owner);
    const theirs = await system.botSection.create({
      data: { spaceId: owner.spaceId, userId: neighborId, name: "Work" },
    });

    const { bot, section } = await runAsTenant(owner, async () => {
      const bot = await repos.createBot(actor, botInput("Filed"));
      const section = await repos.createBotSection(actor, { botId: bot.id, name: "Work" });
      return { bot, section };
    });

    expect(section.id).toBe(theirs.id);
    expect(await system.botSection.count({ where: { spaceId: owner.spaceId, name: "Work" } })).toBe(
      1,
    );
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).sectionId).toBe(
      theirs.id,
    );

    const mine = await runAsTenant(owner, async () => {
      const other = await repos.createBot(actor, botInput("Other"));
      return repos.createBotSection(actor, { botId: other.id, name: "Home" });
    });
    await expect(
      runAsTenant(owner, () => repos.updateBotSection(actor, { sectionId: mine.id, name: "Work" })),
    ).rejects.toBeInstanceOf(BotSectionNameConflictError);
  });

  it("treats another space's section as not found", async () => {
    const repos = createRepos(prisma);
    const { strangerBot, strangerSection } = await runAsTenant(stranger, async () => {
      const strangerBot = await repos.createBot(actorFor(stranger), botInput("Elsewhere"));
      const strangerSection = await repos.createBotSection(actorFor(stranger), {
        botId: strangerBot.id,
        name: "Far",
      });
      return { strangerBot, strangerSection };
    });

    await expect(
      runAsTenant(owner, () =>
        repos.deleteBotSection(actorFor(owner), { sectionId: strangerSection.id }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      (await asSystem(prisma).bot.findUniqueOrThrow({ where: { id: strangerBot.id } })).sectionId,
    ).toBe(strangerSection.id);
  });
});

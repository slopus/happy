import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("bot fleetManagement (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = "+15550004444";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string; botId: string };

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "bot-manager@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string, parentBotId?: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    parentBotId,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (owner) {
      await runAsSystem("test fixture cleanup", async () => {
        await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
        await prisma.organization.deleteMany({ where: { id: owner.spaceId } });
        await prisma.user.deleteMany({ where: { id: owner.userId } });
      });
    }
    await close?.();
  });

  it.each([undefined, "parent"])("createBot enables management by default (parent: %s)", (parent) =>
    runAsTenant(owner, async () => {
      const bot = await createRepos(prisma).createBot(
        actor(),
        botInput("Plain", parent ? owner.botId : undefined),
      );
      expect(bot.fleetManagement).toBe(true);
    }),
  );
  it.each([false, true])("preserves explicit management choice %s", (fleetManagement) =>
    runAsTenant(owner, async () => {
      const bot = await createRepos(prisma).createBot(actor(), {
        ...botInput("Explicit"),
        fleetManagement,
      });
      expect(bot.fleetManagement).toBe(fleetManagement);
      expect((await createRepos(prisma).getBot(actor(), bot.id)).fleetManagement).toBe(
        fleetManagement,
      );
    }),
  );

  it.each(["modelProvider", "modelId", "thinkingLevel"] as const)(
    "preserves an intervening owner edit to %s",
    (field) =>
      runAsTenant(owner, async () => {
        const bot = await createRepos(prisma).createBot(
          actor(),
          botInput("Model child", owner.botId),
        );
        const thread = await prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
        const baseline = { modelProvider: null, modelId: null, thinkingLevel: null };
        await prisma.bot.update({
          where: { id: bot.id },
          data: { [field]: field === "thinkingLevel" ? "high" : "owner-choice" },
        });
        await expect(
          commitBotUpdate({
            prisma,
            notify: async () => undefined,
            spaceId: owner.spaceId,
            threadId: thread.id,
            botId: bot.id,
            expectedSettings: baseline,
            data: { modelProvider: "scripted", modelId: "scripted", thinkingLevel: null },
            emitBotUpdated: true,
          }),
        ).rejects.toMatchObject({ code: "P2025" });
        expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } }))[field]).toBe(
          field === "thinkingLevel" ? "high" : "owner-choice",
        );
        expect(
          await prisma.event.count({ where: { threadId: thread.id, type: "bot.updated" } }),
        ).toBe(0);
      }),
  );
});

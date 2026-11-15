import { destroyBot } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import { requireSpaceOwner } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/** A bot this actor may remove: theirs or the owner's, in this space, archived included. */
export async function loadBotForRemoval(
  prisma: RouterDeps["prisma"],
  repos: ReturnType<typeof createRepos>,
  actor: Actor,
  botId: string,
) {
  const bot = await repos.getBot(actor, botId, { includeArchived: true });
  // Any member can archive; only the bot's creator or the space owner deletes for good.
  if (bot.userId !== actor.userId) await requireSpaceOwner(prisma, actor);
  return bot;
}

export function createBotRemoval(deps: RouterDeps, repos: ReturnType<typeof createRepos>) {
  const removeBot = async (
    actor: Actor,
    botId: string,
    options: Parameters<typeof destroyBot>[3],
  ) => {
    const bot = await loadBotForRemoval(deps.prisma, repos, actor, botId);
    return destroyBot(
      {
        prisma: deps.prisma,
        sandbox: deps.sandbox,
        home: deps.home,
        jobs: deps.jobs,
        memoryProviders: deps.memoryProviders,
        artifacts: deps.artifacts,
        secretStore: deps.secrets,
        dataDir: deps.dataDir,
        messagingInstallations: deps.messagingInstallations,
      },
      bot,
      {
        operationId: "destroy",
        traceId: "destroy",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        signal: new AbortController().signal,
      },
      options,
    );
  };
  return removeBot;
}

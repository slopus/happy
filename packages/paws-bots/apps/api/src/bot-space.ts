import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/** The other Space holding one of the caller's own bots, among the Spaces they belong to in any organization. */
export function otherSpaceOfBot(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<string | undefined> {
  return runAsSystem("find which of the caller's Spaces holds their bot", async () => {
    const bot = await prisma.bot.findFirst({
      where: {
        id: botId,
        userId: actor.userId,
        archivedAt: null,
        spaceId: { not: actor.spaceId },
        space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      },
      select: { spaceId: true },
    });
    return bot?.spaceId;
  });
}

import type { PrismaClient } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";

/**
 * Give the bot `name` for good. A name is never reissued, even after its bot is deleted, so mail
 * meant for one bot never reaches another. Claiming the bot's own name again changes nothing.
 */
export async function claimBotEmailName(
  prisma: PrismaClient,
  botId: string,
  name: string,
): Promise<"claimed" | "taken" | "has-another"> {
  const existing = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { name: true },
  });
  if (existing) return existing.name === name ? "claimed" : "has-another";
  try {
    await prisma.botEmailAddress.create({ data: { name, botId } });
    return "claimed";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The name went to another bot, or a concurrent claim for this bot won, with any name.
    const current = await prisma.botEmailAddress.findUnique({
      where: { botId },
      select: { name: true },
    });
    if (current) return current.name === name ? "claimed" : "has-another";
    return "taken";
  }
}

import { ORPCError } from "@orpc/server";
import type { BotEmailAddress, BotEmailAddresses } from "@rakazo/contracts";
import { BOT_EMAIL_NAME_TAKEN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { claimBotEmailName } from "@rakazo/db";

export const EMAIL_NOT_RECEIVED = "This server doesn't receive email.";

/** The bot's address, once claimed; null when this server receives no email. */
export async function botEmailAddress(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
): Promise<BotEmailAddress> {
  if (!domain) return null;
  const row = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { name: true },
  });
  return { domain, address: row ? `${row.name}@${domain}` : null };
}

/** The addresses of the owner's own bots in this Space, for the Vault; null without email. */
export async function botEmailAddresses(
  prisma: PrismaClient,
  domain: string | undefined,
  owner: { spaceId: string; userId: string },
): Promise<BotEmailAddresses> {
  if (!domain) return null;
  const rows = await prisma.botEmailAddress.findMany({
    // Archived bots receive no mail, so their addresses would only mislead.
    where: { bot: { spaceId: owner.spaceId, userId: owner.userId, archivedAt: null } },
    select: { name: true, bot: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  return {
    domain,
    addresses: rows.flatMap((row) =>
      row.bot
        ? [{ botId: row.bot.id, botName: row.bot.name, address: `${row.name}@${domain}` }]
        : [],
    ),
  };
}

/** Give the bot `name`@domain for good; see claimBotEmailName. */
export async function claimBotEmailAddress(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
  name: string,
): Promise<{ address: string }> {
  if (!domain) throw new ORPCError("BAD_REQUEST", { message: EMAIL_NOT_RECEIVED });
  const result = await claimBotEmailName(prisma, botId, name);
  if (result === "has-another") {
    throw new ORPCError("CONFLICT", { message: "This bot already has an address." });
  }
  if (result === "taken") throw new ORPCError("CONFLICT", { message: BOT_EMAIL_NAME_TAKEN });
  return { address: `${name}@${domain}` };
}

/** An email trigger needs a server that receives mail and a bot with an address. */
export async function assertEmailTrigger(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
): Promise<void> {
  if (!domain) throw new ORPCError("BAD_REQUEST", { message: EMAIL_NOT_RECEIVED });
  const row = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { botId: true },
  });
  if (!row) {
    throw new ORPCError("BAD_REQUEST", { message: "Choose an email address for this bot first." });
  }
}

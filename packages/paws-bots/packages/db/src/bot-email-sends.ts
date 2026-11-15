import { BotEmailRecipientSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = "an owner's email sends across their Spaces";

/** Owner-scoped reservations serialize only the short database check, never delivery. */
export function reserveBotEmailSend(
  prisma: PrismaClient,
  send: { userId: string; botId: string; recipients: string[]; verifiedReplySender?: string },
  now = new Date(),
): Promise<{ id: string } | "limit" | "disabled" | "unverified" | "recipient" | "too_many"> {
  if (!send.recipients.length || send.recipients.length > 10)
    throw new Error("Reserve between one and ten recipients");
  const since = new Date(now.getTime() - DAY_MS);
  return runAsSystem(REASON, () =>
    prisma.$transaction(async (tx) => {
      // Previous-release workers use this lock; keep coordinating during rolling deploys.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`bot-email-send:${send.userId}`}, 0))::text AS "lock"`;
      await tx.$queryRaw`
        SELECT id FROM "user" WHERE id=${send.userId} FOR NO KEY UPDATE`;
      const owner = await tx.user.findUnique({
        where: { id: send.userId },
        select: {
          email: true,
          emailVerified: true,
          deactivatedAt: true,
          botEmailDailyLimit: true,
          botEmailRepliesEnabled: true,
          botEmailAllowedRecipients: true,
        },
      });
      if (!owner || owner.deactivatedAt || owner.botEmailDailyLimit <= 0) return "disabled";
      if (!owner.emailVerified) return "unverified";
      const allowed = new Set<string>();
      const addresses = [owner.email, ...owner.botEmailAllowedRecipients];
      if (owner.botEmailRepliesEnabled && send.verifiedReplySender)
        addresses.push(send.verifiedReplySender);
      for (const address of addresses) {
        const parsed = BotEmailRecipientSchema.safeParse(address);
        if (parsed.success) allowed.add(parsed.data);
      }
      if (
        send.recipients.some((address) => {
          const parsed = BotEmailRecipientSchema.safeParse(address);
          return !parsed.success || !allowed.has(parsed.data);
        })
      )
        return "recipient";
      if (send.recipients.length > owner.botEmailDailyLimit) return "too_many";
      await tx.botEmailSend.deleteMany({ where: { userId: send.userId, sentAt: { lt: since } } });
      const total = await tx.botEmailSend.aggregate({
        where: { userId: send.userId },
        _sum: { recipientCount: true },
      });
      if ((total._sum.recipientCount ?? 0) + send.recipients.length > owner.botEmailDailyLimit)
        return "limit";
      return tx.botEmailSend.create({
        data: {
          userId: send.userId,
          botId: send.botId,
          sentAt: now,
          recipientCount: send.recipients.length,
        },
        select: { id: true },
      });
    }),
  );
}

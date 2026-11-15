// Operator-only: bot-email-policy.js status <email> | limit <email> <0..1000> | replies <email> on|off | allow|deny <email> <recipient>
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import { BotEmailRecipientSchema } from "@rakazo/contracts";
import { createDb, runAsSystem } from "@rakazo/db";
import { loadEnv } from "../env.js";

const [action, address, value, ...extra] = process.argv.slice(2);
const recipient = BotEmailRecipientSchema.safeParse(value?.trim());
if (
  !address ||
  extra.length ||
  !(
    (action === "status" && value === undefined) ||
    (action === "limit" && /^(?:0|[1-9]\d{0,3})$/.test(value ?? "") && Number(value) <= 1000) ||
    (action === "replies" && (value === "on" || value === "off")) ||
    ((action === "allow" || action === "deny") && recipient.success)
  )
) {
  process.stderr.write(
    "Usage: bot-email-policy.js status <email> | limit <email> <0..1000> | replies <email> on|off | allow|deny <email> <recipient>\n",
  );
  process.exit(2);
}

await unwrapEnvFromKeyManager();
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
try {
  await runAsSystem("manage an account's bot email sending policy", () =>
    prisma.$transaction(async (tx) => {
      const matches = await tx.user.findMany({
        where: { email: { equals: address.trim(), mode: "insensitive" } },
        select: { id: true },
        take: 2,
      });
      if (matches.length !== 1) throw new Error("No single account has that email");
      const userId = matches[0]!.id;
      await tx.$queryRaw`SELECT id FROM "user" WHERE id=${userId} FOR NO KEY UPDATE`;
      const select = {
        botEmailDailyLimit: true,
        botEmailRepliesEnabled: true,
        botEmailAllowedRecipients: true,
      } as const;
      const previous = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ...select, email: true },
      });
      if (previous.email.toLowerCase() !== address.trim().toLowerCase())
        throw new Error("Account email changed while waiting; no policy change was applied");
      const policy =
        action === "status"
          ? previous
          : await tx.user.update({
              where: { id: userId },
              data:
                action === "limit"
                  ? { botEmailDailyLimit: Number(value) }
                  : action === "replies"
                    ? { botEmailRepliesEnabled: value === "on" }
                    : {
                        botEmailAllowedRecipients:
                          action === "allow"
                            ? [...new Set([...previous.botEmailAllowedRecipients, recipient.data!])]
                            : previous.botEmailAllowedRecipients.filter(
                                (address) => address !== recipient.data!,
                              ),
                      },
              select,
            });
      if (action !== "status")
        await tx.securityEvent.create({
          data: {
            type: "bot_email.policy.changed",
            userId,
            metadata: {
              by: "operator",
              previousLimit: previous.botEmailDailyLimit,
              previousReplies: previous.botEmailRepliesEnabled,
              limit: policy.botEmailDailyLimit,
              replies: policy.botEmailRepliesEnabled,
              recipientCount: policy.botEmailAllowedRecipients.length,
              previousRecipientCount: previous.botEmailAllowedRecipients.length,
              change: action,
              changed:
                previous.botEmailDailyLimit !== policy.botEmailDailyLimit ||
                previous.botEmailRepliesEnabled !== policy.botEmailRepliesEnabled ||
                previous.botEmailAllowedRecipients.length !==
                  policy.botEmailAllowedRecipients.length,
              ...((action === "allow" || action === "deny") && recipient.success
                ? { recipient: recipient.data }
                : {}),
            },
          },
        });
      process.stdout.write(
        `Daily recipient allowance: ${policy.botEmailDailyLimit}\nExternal replies: ${policy.botEmailRepliesEnabled ? "on" : "off"}\nApproved recipients: ${policy.botEmailAllowedRecipients.length}\n`,
      );
      if (action === "status")
        for (const approved of policy.botEmailAllowedRecipients)
          process.stdout.write(`${approved}\n`);
    }),
  );
} finally {
  await prisma.$disconnect();
  await pool.end();
}

import * as z from "zod";

/** Preserve mailbox casing; only the domain is case-insensitive. */
export const BotEmailRecipientSchema = z.email().transform((address) => {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
});

export const BOT_EMAIL_NAME_TAKEN = "That address isn't available";

/** Role and abuse-desk names (RFC 2142), names people trust by reflex, and the project's own. */
const RESERVED_BOT_EMAIL_NAMES = new Set([
  "abuse",
  "accounts",
  "admin",
  "administrator",
  "billing",
  "careers",
  "contact",
  "elie",
  "help",
  "hello",
  "hi",
  "hostmaster",
  "info",
  "jobs",
  "legal",
  "mail",
  "mailer-daemon",
  "marketing",
  "no-reply",
  "noc",
  "noreply",
  "notifications",
  "partners",
  "postmaster",
  "press",
  "privacy",
  "rakazo",
  "root",
  "sales",
  "security",
  "support",
  "team",
  "verify",
  "webmaster",
]);

/** A reserved name, alone or before a separator (support-team, admin.bot), or anything rakazo*. */
function isReservedBotEmailName(name: string): boolean {
  return (
    name.startsWith("rakazo") ||
    [...RESERVED_BOT_EMAIL_NAMES].some(
      (reserved) =>
        name.startsWith(reserved) && ["", ".", "-", "_"].includes(name.charAt(reserved.length)),
    )
  );
}

/** The part of a bot's address before the @, as its owner chose it. */
export const BotEmailNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Use at least 2 characters")
  .max(64, "Use at most 64 characters")
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Use letters, numbers, dots, dashes or underscores")
  .refine((name) => !name.includes(".."), "Use letters, numbers, dots, dashes or underscores")
  .refine((name) => !isReservedBotEmailName(name), BOT_EMAIL_NAME_TAKEN);

/** Why a name can't be claimed, for each app to word in its own language. */
export type BotEmailNameProblem = "length" | "taken" | "characters";

/** A name the owner typed, ready to claim, or what is wrong with it. */
export function parseBotEmailName(
  raw: string,
): { name: string; problem?: undefined } | { name?: undefined; problem: BotEmailNameProblem } {
  const parsed = BotEmailNameSchema.safeParse(raw);
  if (parsed.success) return { name: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    problem:
      issue?.code === "too_small" || issue?.code === "too_big"
        ? "length"
        : issue?.message === BOT_EMAIL_NAME_TAKEN
          ? "taken"
          : "characters",
  };
}

/** Null when this server receives no email, or for anyone but the bot's owner. */
export const BotEmailAddressSchema = z
  .object({
    domain: z.string(),
    /** Null until the owner claims a name. */
    address: z.string().nullable(),
  })
  .nullable();
export type BotEmailAddress = z.infer<typeof BotEmailAddressSchema>;

/** The addresses of the caller's own bots in this Space; null when this server receives no email. */
export const BotEmailAddressesSchema = z
  .object({
    domain: z.string(),
    addresses: z.array(z.object({ botId: z.string(), botName: z.string(), address: z.string() })),
  })
  .nullable();
export type BotEmailAddresses = z.infer<typeof BotEmailAddressesSchema>;

/**
 * A first address suggestion from a bot's name, such as "research-helper". ASCII only: many mail
 * servers still refuse non-ASCII addresses. Empty when nothing in the name can be kept or what
 * is left is reserved.
 */
export function suggestedEmailName(botName: string): string {
  const name = botName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return isReservedBotEmailName(name) ? "" : name;
}

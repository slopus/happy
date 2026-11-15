import { setTimeout as sleep } from "node:timers/promises";
import {
  BOT_EMAIL_NAME_TAKEN,
  BotEmailNameSchema,
  BotEmailRecipientSchema,
} from "@rakazo/contracts";
import { attachmentComputerPath, matchesSearchQuery, redactSecrets } from "@rakazo/core";
import { claimBotEmailName, contentEncryptionOf, reserveBotEmailSend } from "@rakazo/db";
import { z } from "zod";
import { redactConnectorPayload } from "./connector-safety.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argsError } from "./tool-args.js";

/** Longest a read_email call waits for mail to arrive, well inside a run's lease renewal. */
export const READ_EMAIL_MAX_WAIT_SECONDS = 120;
/** Body text one read returns; a longer email continues from nextTextOffset. */
const TEXT_PAGE_CHARS = 8_000;
const PREVIEW_CHARS = 160;
const POLL_MS = 3_000;
/** Emails one delete_email call removes. */
const DELETE_EMAIL_MAX_IDS = 50;
/** Emails a search fetches to check once decrypted, as blind-index matches can be false. */
const SEARCH_CANDIDATES = 100;
const SEARCHED_FIELDS = ["fromAddress", "fromName", "subject", "text"] as const;

const ReadEmailSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    query: z.string().trim().max(200).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    waitSeconds: z.number().int().min(0).max(READ_EMAIL_MAX_WAIT_SECONDS).optional(),
    textOffset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const DeleteEmailSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(100)).min(1).max(DELETE_EMAIL_MAX_IDS),
  })
  .strict();

function sender(email: { fromName: string; fromAddress: string }): string {
  return email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress;
}

type SavedFile = { name: string; artifactId?: string; mimeType?: string; size?: number };

/**
 * Plaintext mail matches the query inside any field. Encrypted mail matches on blind-index
 * prefix tokens and is checked against its decrypted fields afterwards (`check`), so text inside
 * a word only matches mail that is still plaintext, as in Space search.
 */
async function emailQuery(ctx: RunContext, query: string) {
  const plaintext = SEARCHED_FIELDS.map((field) => ({
    [field]: { contains: query, mode: "insensitive" as const },
  }));
  const encryption = contentEncryptionOf(ctx.deps.prisma);
  const keyTokens = encryption
    ? await encryption.messageSearchTokens(ctx.bot.spaceId, query, "prefix")
    : [];
  // No keys: nothing in the Space was ever encrypted.
  if (!keyTokens.length) return { where: { OR: plaintext }, check: false };
  const tokenSets = keyTokens.filter((tokens) => tokens.length);
  // No term long enough to be indexed: check the newest mail.
  if (!tokenSets.length) return { where: {}, check: true };
  const encrypted = tokenSets.map((tokens) => ({ searchTokens: { hasEvery: tokens } }));
  return { where: { OR: [...encrypted, ...plaintext] }, check: true };
}

async function readEmail(ctx: RunContext, call: ToolCall) {
  const parsed = ReadEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
  }
  const input = parsed.data;
  const { deps, bot, run } = ctx;
  // The inbox is the owner's mail: only their own runs of their own bot read it.
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });

  if (input.id) {
    const email = await deps.prisma.botEmailMessage.findFirst({
      where: { id: input.id, botId: bot.id },
    });
    if (!email) return call.finish({ error: "No email with that id in your inbox." });
    const offset = input.textOffset ?? 0;
    // Masked whole before paging, so a secret split across two pages is still caught.
    const body = redactSecrets(email.text, ctx.secrets);
    const text = body.slice(offset, offset + TEXT_PAGE_CHARS);
    const files = email.attachments as SavedFile[];
    const kept = files.flatMap((file) =>
      file.artifactId && file.mimeType
        ? [
            {
              kind: "file" as const,
              artifactId: file.artifactId,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size ?? 0,
            },
          ]
        : [],
    );
    // Copied before the bot's next computer tool, where history tools put files too.
    ctx.computer.copyEarlierFiles(kept);
    // A service can echo a password or code the bot holds as a secret.
    const shown = redactConnectorPayload(
      {
        id: email.id,
        from: sender(email),
        ...(email.sent ? { sent: true } : { verified: email.verified }),
        to: email.to,
        ...(email.cc.length ? { cc: email.cc } : {}),
        subject: email.subject,
        receivedAt: email.receivedAt.toISOString(),
        text,
        ...(offset + TEXT_PAGE_CHARS < body.length
          ? { nextTextOffset: offset + TEXT_PAGE_CHARS }
          : {}),
        ...(files.length
          ? {
              files: files.map((file) =>
                file.artifactId && file.mimeType
                  ? {
                      name: file.name,
                      path: attachmentComputerPath(file.artifactId, file.mimeType),
                    }
                  : { name: file.name, unavailable: true },
              ),
            }
          : {}),
      },
      ctx.secrets,
    );
    return call.finish({ untrusted: true, email: shown });
  }

  const startedAt = Date.now();
  const where = {
    botId: bot.id,
    // Waiting is for mail to arrive, so what the bot sent never ends it.
    ...(input.waitSeconds ? { sent: false } : {}),
    ...(input.since || input.before
      ? {
          receivedAt: {
            ...(input.since ? { gt: new Date(input.since) } : {}),
            ...(input.before ? { lt: new Date(input.before) } : {}),
          },
        }
      : {}),
  };
  const limit = input.limit ?? 10;
  // After since: the newest email already looked at, so candidates a search checked and dropped
  // are not checked again by this wait or by a caller following nextSince.
  let checkedTo: Date | undefined;
  // Asked again on every look: a Space's first key can appear while the bot waits.
  const list = async () => {
    const search = input.query ? await emailQuery(ctx, input.query) : undefined;
    const found = await deps.prisma.botEmailMessage.findMany({
      where: {
        ...where,
        ...(checkedTo ? { receivedAt: { ...where.receivedAt, gt: checkedTo } } : {}),
        ...search?.where,
      },
      // After since, oldest first, so following nextSince reads every new email in order.
      orderBy: { receivedAt: input.since ? ("asc" as const) : ("desc" as const) },
      take: search?.check ? SEARCH_CANDIDATES : limit,
      select: {
        id: true,
        fromAddress: true,
        fromName: true,
        verified: true,
        sent: true,
        subject: true,
        receivedAt: true,
        text: true,
        attachments: true,
      },
    });
    if (!search?.check) return found;
    const matches = found.filter((email) =>
      matchesSearchQuery(input.query!, ...SEARCHED_FIELDS.map((field) => email[field])),
    );
    if (input.since)
      checkedTo =
        (matches.length >= limit ? matches[limit - 1] : found.at(-1))?.receivedAt ?? checkedTo;
    return matches.slice(0, limit);
  };
  let emails = await list();
  const deadline = startedAt + (input.waitSeconds ?? 0) * 1000;
  // The last look lands on the deadline, so a wait shorter than one poll still waits.
  for (
    let left = deadline - Date.now();
    emails.length === 0 && left > 0;
    left = deadline - Date.now()
  ) {
    await sleep(Math.min(POLL_MS, left), undefined, { signal: ctx.context.signal });
    emails = await list();
  }
  // Where the next look starts, on the inbox's own clock: the newest email shown here, or the
  // caller's since when nothing new arrived.
  const newest = input.since ? emails.at(-1) : emails[0];
  const nextSince = (checkedTo ?? newest?.receivedAt)?.toISOString() ?? input.since;
  const listed = emails.map((email) => ({
    id: email.id,
    from: sender(email),
    ...(email.sent ? { sent: true } : { verified: email.verified }),
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
    preview: redactSecrets(email.text, ctx.secrets)
      .slice(0, PREVIEW_CHARS)
      .replace(/\s+/g, " ")
      .trim(),
    ...((email.attachments as SavedFile[]).length
      ? { files: (email.attachments as SavedFile[]).length }
      : {}),
  }));
  return call.finish({
    untrusted: true,
    ...(nextSince ? { nextSince } : {}),
    emails: redactConnectorPayload(listed, ctx.secrets),
  });
}

async function deleteEmail(ctx: RunContext, call: ToolCall) {
  const parsed = DeleteEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
  }
  const { deps, bot, run } = ctx;
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Only mail it received: the bot's own sent mail stays as its record of what went out.
  const { count } = await deps.prisma.botEmailMessage.deleteMany({
    where: { id: { in: [...new Set(parsed.data.ids)] }, botId: bot.id, sent: false },
  });
  return call.finish({ deleted: count });
}

/** The owner gives the bot its permanent address from chat. */
async function claimEmailAddress(ctx: RunContext, call: ToolCall) {
  const { deps, bot, run } = ctx;
  const domain = deps.inboundEmailDomain;
  if (!domain) return call.finish({ error: "This server doesn't receive email." });
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Permanent: without the owner's own approval of this call, text the bot read cannot pick it.
  if (call.nextApprovedTool !== "claim_email_address" && (await isRunTainted(ctx))) {
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "An email address can't be claimed in this run because it read outside content. Ask your owner to request it again.",
      ),
    );
  }
  const parsed = BotEmailNameSchema.safeParse(call.args.name);
  if (!parsed.success) {
    return call.finish({ error: parsed.error.issues[0]?.message ?? "Choose another name." });
  }
  const result = await claimBotEmailName(deps.prisma, bot.id, parsed.data);
  if (result === "taken")
    return call.finish({ error: `${BOT_EMAIL_NAME_TAKEN}. Ask for another.` });
  if (result === "has-another") {
    const current = await deps.prisma.botEmailAddress.findUnique({
      where: { botId: bot.id },
      select: { name: true },
    });
    return call.finish({
      error: "You already have an address, and it can't change.",
      address: current ? `${current.name}@${domain}` : undefined,
    });
  }
  return call.finish({ address: `${parsed.data}@${domain}` });
}

const SEND_RECIPIENTS_MAX = 10;
const SEND_TEXT_MAX_CHARS = 20_000;
const SUBJECT_MAX_CHARS = 500;
const MAX_REFERENCES = 20;

const Recipients = z
  .union([BotEmailRecipientSchema, z.array(BotEmailRecipientSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]));
const SendEmailSchema = z
  .object({
    to: Recipients.refine((list) => list.length > 0, "Name at least one recipient."),
    cc: Recipients.optional(),
    subject: z.string().trim().max(SUBJECT_MAX_CHARS).optional(),
    text: z.string().trim().min(1).max(SEND_TEXT_MAX_CHARS),
    inReplyTo: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

/** Email from the bot's own address; replies come back to its inbox. */
async function sendEmail(ctx: RunContext, call: ToolCall) {
  const { deps, bot, run } = ctx;
  const domain = deps.inboundEmailDomain;
  if (!deps.email || !domain) return call.finish({ error: "This server can't send email." });
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  const parsed = SendEmailSchema.safeParse(call.args);
  if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
  const input = parsed.data;
  const cc = input.cc ?? [];
  if (input.to.length + cc.length > SEND_RECIPIENTS_MAX) {
    return call.finish({ error: `Send to at most ${SEND_RECIPIENTS_MAX} people at once.` });
  }
  // An address can carry a secret out as surely as the body, and can't be redacted into another.
  // Compared lowercased, so a change of case can't slip a secret past.
  const secrets = ctx.secrets.map((secret) => secret.toLowerCase());
  if (
    [...input.to, ...cc].some(
      (address) => redactSecrets(address.toLowerCase(), secrets) !== address.toLowerCase(),
    )
  ) {
    return call.finish({ error: "A recipient's address contains a secret. Don't send it." });
  }
  const name = await deps.prisma.botEmailAddress.findUnique({
    where: { botId: bot.id },
    select: { name: true },
  });
  if (!name) return call.finish({ error: "You don't have an email address yet." });
  const address = `${name.name}@${domain}`;

  const original = input.inReplyTo
    ? await deps.prisma.botEmailMessage.findFirst({
        where: { id: input.inReplyTo, botId: bot.id },
        select: {
          subject: true,
          messageId: true,
          references: true,
          fromAddress: true,
          verified: true,
          sent: true,
          receivedAt: true,
        },
      })
    : null;
  if (input.inReplyTo && !original) {
    return call.finish({ error: "No email with that id in your inbox." });
  }
  // Redacted before lines are joined, so a secret that spans lines still matches.
  const subject = redactSecrets(
    input.subject ||
      (original
        ? /^re:/i.test(original.subject)
          ? original.subject
          : `Re: ${original.subject}`
        : ""),
    ctx.secrets,
  )
    .replace(/[\r\n]+/g, " ")
    .slice(0, SUBJECT_MAX_CHARS);
  if (!subject) return call.finish({ error: "Give the email a subject." });
  // Secrets this run has used never leave in an email, whatever the bot was asked to write.
  const text = redactSecrets(input.text, ctx.secrets);
  if (text.length > SEND_TEXT_MAX_CHARS) {
    return call.finish({ error: "The email is too long once secrets are removed. Shorten it." });
  }
  // A reply to mail the bot sent answers what that one answered: its own ID is the provider's.
  const parent = original?.messageId ?? original?.references.at(-1);
  const references = original?.messageId
    ? [...original.references, original.messageId].slice(-MAX_REFERENCES)
    : (original?.references ?? []);

  const key = `sent:${call.effectKey}`;
  // Only what the bot chose: a reply's subject repeats what the sender wrote, outside text that
  // this result, counted as the bot's own, must not carry.
  const done = (id: string) =>
    call.finish({ sent: true, id, from: address, to: input.to, ...(cc.length ? { cc } : {}) });
  const earlier = await deps.prisma.botEmailMessage.findUnique({
    where: { botId_key: { botId: bot.id, key } },
    select: { id: true },
  });
  // A finished send is replayed by the gate, so a row found here is an attempt cut off midway.
  if (earlier) {
    return call.finish({
      error:
        "An earlier attempt to send this email was interrupted and may or may not have gone out. Tell your owner instead of sending it again.",
      id: earlier.id,
    });
  }
  // Only a recent, authenticated incoming message authorizes a reply recipient.
  // A sent copy, forged message, or caller-supplied address can never grant that permission.
  const verifiedReplySender =
    original?.verified &&
    !original.sent &&
    original.receivedAt.getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000 &&
    original.fromAddress.split("@").at(-1)?.toLowerCase() !== domain.toLowerCase()
      ? original.fromAddress
      : undefined;
  const reserved = await reserveBotEmailSend(deps.prisma, {
    userId: bot.userId,
    botId: bot.id,
    recipients: [...input.to, ...cc],
    verifiedReplySender,
  });
  if (typeof reserved === "string") {
    const errors = {
      limit: "Your account has reached its email allowance for the last 24 hours. Try again later.",
      too_many:
        "This email has more recipients than your account's allowance. Send to fewer recipients.",
      disabled: "Email sending is paused for this account.",
      unverified: "Verify your account email before sending.",
      recipient: "This recipient isn't approved for this account.",
    };
    return call.finish({ error: errors[reserved] });
  }
  // Saved before it goes: a retry after a crash finds it and never sends the email twice.
  const row = await deps.prisma.botEmailMessage.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      key,
      references,
      fromAddress: address,
      fromName: bot.name,
      verified: true,
      sent: true,
      to: input.to,
      cc,
      subject,
      text,
    },
    select: { id: true },
  });
  try {
    await deps.email.send({
      from: `"${bot.name.replace(/["\\\r\n]/g, "")}" <${address}>`,
      replyTo: address,
      to: input.to,
      ...(cc.length ? { cc } : {}),
      subject,
      text,
      ...(parent ? { headers: { "In-Reply-To": parent, References: references.join(" ") } } : {}),
    });
  } catch (error) {
    await deps.prisma.botEmailMessage.delete({ where: { id: row.id } }).catch(() => undefined);
    // Most failures are refusals, but one can come after the provider took the email, so the
    // reserved send keeps counting toward the daily limits either way.
    return call.finish({
      error: `Sending failed (${error instanceof Error ? error.message : String(error)}). It most likely did not go out.`,
    });
  }
  return done(row.id);
}

/** The bot's own address and inbox: mail anyone sent to it, and mail it sends. */
export const emailTools: ToolHandlers = {
  read_email: readEmail,
  delete_email: deleteEmail,
  claim_email_address: claimEmailAddress,
  send_email: sendEmail,
};

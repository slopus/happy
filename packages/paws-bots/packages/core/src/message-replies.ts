import type { MessageAuthor, MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { MessageAuthorSchema, ReplyPreviewSchema } from "@rakazo/contracts";
import { isQuestionAskBlock } from "./ask-kind.js";
import { displayName } from "./display-name.js";
import { plainTextFromMarkdown } from "./markdown-plain.js";
import { messageReaction } from "./message-reactions.js";
import { isDeliveryMessage } from "./message-visibility.js";

/** Bound the source considered when deriving a reply excerpt. */
export const MAX_QUOTABLE_SOURCE_LENGTH = 100_000;

/** The first nonblank reply line, capped without splitting a surrogate pair. */
export function compactReplyExcerpt(text: string): string {
  const first = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const excerpt = (first ?? "").slice(0, 280);
  return /[\uD800-\uDBFF]$/u.test(excerpt) ? excerpt.slice(0, -1) : excerpt;
}

type ReplyMetadata = {
  replyToMessageId?: string;
  replyQuote?: string;
  replyPreview?: ReplyPreview | null;
};

/** Updates may omit reply metadata; retain it until an authoritative value arrives. */
export function replyMetadata(
  payload: Record<string, unknown>,
  previous?: ReplyMetadata,
): ReplyMetadata {
  const preview = ReplyPreviewSchema.nullable().safeParse(payload.replyPreview);
  return {
    replyToMessageId:
      typeof payload.replyToMessageId === "string"
        ? payload.replyToMessageId
        : previous?.replyToMessageId,
    replyQuote: typeof payload.replyQuote === "string" ? payload.replyQuote : previous?.replyQuote,
    replyPreview: preview.success ? preview.data : previous?.replyPreview,
  };
}

/** The author a live message event carries; updates omit it, so keep the known one. */
export function payloadAuthor(
  payload: Record<string, unknown>,
  previous?: { author?: MessageAuthor },
): { author?: MessageAuthor } {
  const parsed = MessageAuthorSchema.safeParse(payload.author);
  const author = parsed.success ? parsed.data : previous?.author;
  return author ? { author } : {};
}

/** Someone else in a shared space; my own messages and unknown senders stay unnamed. */
export function otherAuthor(
  author: MessageAuthor | undefined,
  meId: string | undefined,
): MessageAuthor | undefined {
  return author && meId && author.id !== meId ? author : undefined;
}

/**
 * A message that leaves the chat unread for this viewer until they read it: a bot's, or one
 * someone else in the space wrote. Their own never does. Takes a stored message or a live
 * event's payload.
 */
export function messageUnreadFor(
  message: { role?: unknown; author?: unknown },
  meId: string | undefined,
) {
  return (
    message.role === "bot" ||
    (message.role === "user" && Boolean(otherAuthor(payloadAuthor(message).author, meId)))
  );
}

/**
 * Whether a person's message alerts the rest of the space, by push or on the desktop: typed
 * text does; a spoken call turn, a reaction or a file sent alone does not.
 */
export function memberMessageAlerts(message: {
  callId?: unknown;
  blocks?: unknown;
  replyToMessageId?: unknown;
}): boolean {
  const blocks = (Array.isArray(message.blocks) ? message.blocks : []) as MessageBlock[];
  const replyToMessageId =
    typeof message.replyToMessageId === "string" ? message.replyToMessageId : undefined;
  return (
    typeof message.callId !== "string" &&
    !messageReaction({ role: "user", blocks, replyToMessageId }) &&
    blocks.some(
      (block) =>
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.trim() !== "",
    )
  );
}

export function replyLineText(quote?: string, preview?: string, fallback?: string): string {
  return quote ? quote.replace(/\s+/gu, " ") : (preview || fallback || "").split(/\r?\n/u)[0] || "";
}

/** Pick only metadata from validated parent blocks, preferring a photo over a file. */
export function replyAttachment(blocks: MessageBlock[]): ReplyPreview["attachment"] {
  const block =
    blocks.find((block) => block.kind === "image") ?? blocks.find((block) => block.kind === "file");
  if (!block || (block.kind !== "image" && block.kind !== "file")) return undefined;
  return {
    kind: block.kind,
    artifactId: block.artifactId,
    mimeType: block.mimeType,
    name: block.name,
  };
}

export function replyLabel(
  quote: string | null | undefined,
  text: string | undefined,
  attachment: ReplyPreview["attachment"],
  labels: { photo: string; attachment: string },
): string {
  // Older sends persisted the image filename/agent placeholder as a quote.
  const legacyImageQuote =
    attachment?.kind === "image" &&
    !text &&
    (quote === attachment.name || quote === `[image: ${attachment.name}]`);
  return replyLineText(
    legacyImageQuote ? undefined : (quote ?? undefined),
    text,
    attachment?.kind === "image" ? labels.photo : attachment?.name || labels.attachment,
  );
}

/**
 * Who wrote a message relayed from an outside channel. Those arrive as user messages, so a reply
 * to one names its sender rather than "You".
 */
export function channelMessageSender(blocks: MessageBlock[]): string | undefined {
  const block = blocks.find((candidate) => candidate.kind === "channel_message");
  return block?.kind === "channel_message"
    ? displayName(block.fromLabel, "") || undefined
    : undefined;
}

/**
 * A message's text for a reply line before the server's preview arrives. Channel
 * messages show their text alone, matching the server-owned preview.
 */
export function previewMessageText(
  message: { role: string; blocks: MessageBlock[] },
  labels: { photo: string; attachment: string; message: string },
): string {
  if (isDeliveryMessage(message.blocks)) return labels.message;
  const text = message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return block.text;
      if (block.kind === "text") {
        // Bot text is Markdown; user text is already plain.
        return message.role === "bot" ? plainTextFromMarkdown(block.text) : block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  for (const block of message.blocks) {
    if (block.kind === "ask" && isQuestionAskBlock(block)) {
      const excerpt = compactReplyExcerpt(block.text.slice(0, MAX_QUOTABLE_SOURCE_LENGTH));
      if (excerpt) return excerpt;
    }
  }
  const attachment = replyAttachment(message.blocks);
  if (attachment)
    return attachment.kind === "image" ? labels.photo : attachment.name || labels.attachment;
  return labels.message;
}

/** A message sent from an open page replies to the page's card but shows no quote of it. */
export function isPageOriginReply(message: {
  replyQuote?: string | null;
  replyPreview?: ReplyPreview | null;
}): boolean {
  return message.replyPreview?.page === true && !message.replyQuote;
}

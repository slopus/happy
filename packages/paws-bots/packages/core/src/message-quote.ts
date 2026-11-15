import type { MessageBlock, ReplyPreview } from "@rakazo/contracts";
import { droppedTableHtmlText, truncateReplyQuote } from "@rakazo/contracts";
import { toText } from "hast-util-to-text";
import { toHast } from "mdast-util-to-hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isQuestionAskBlock } from "./ask-kind.js";
import { blocksToAgentHistoryText } from "./attachments.js";
import {
  compactReplyExcerpt,
  MAX_QUOTABLE_SOURCE_LENGTH,
  replyAttachment,
} from "./message-replies.js";
import { isDeliveryMessage } from "./message-visibility.js";

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export { MAX_QUOTABLE_SOURCE_LENGTH } from "./message-replies.js";

type MdastNode = { type?: string; value?: string; children?: MdastNode[] };

/* The web renderer salvages <br> and <img alt> text inside table cells
   (preserveSkippedTableText in @rakazo/chat-ui). Both sides share
   droppedTableHtmlText from @rakazo/contracts so a quote of a rendered cell
   validates against the same canonical text. */
function salvageSkippedTableHtml(node: MdastNode, insideCell = false): void {
  const inCell = insideCell || node.type === "tableCell";
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (inCell && child.type === "html") {
      const value = droppedTableHtmlText(child.value ?? "");
      return value === null ? child : { type: "text", value };
    }
    salvageSkippedTableHtml(child, inCell);
    return child;
  });
}

type NormalizedText = {
  text: string;
  starts: number[];
  ends: number[];
};

/** Render Markdown to the text exposed by the web renderer, without UI chrome. */
export function visibleTextFromMarkdown(markdown: string): string {
  const mdast = markdownParser.parse(markdown);
  salvageSkippedTableHtml(mdast as MdastNode);
  return toText(toHast(mdast));
}

function normalizeWithOffsets(value: string): NormalizedText {
  const source = value.normalize("NFC");
  const starts: number[] = [];
  const ends: number[] = [];
  let text = "";
  let whitespaceStart: number | undefined;

  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      whitespaceStart ??= index;
      continue;
    }
    if (whitespaceStart !== undefined && text) {
      text += " ";
      starts.push(whitespaceStart);
      ends.push(index);
    }
    whitespaceStart = undefined;
    text += char;
    starts.push(index);
    ends.push(index + 1);
  }

  return { text, starts, ends };
}

function cleanVisibleExcerpt(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve an untrusted selected-text hint to an authoritative parent excerpt.
 * Only persisted text blocks are quotable; the format must match their renderer.
 * Punctuation and case stay significant.
 */
export function deriveMessageQuote(
  blocks: MessageBlock[],
  quoteHint: string,
  format: "markdown" | "plain-text",
): string | undefined {
  // A delivery's text is the bot's hidden prompt, never quoted.
  if (isDeliveryMessage(blocks)) return undefined;
  const hint = normalizeWithOffsets(truncateReplyQuote(quoteHint.trim())).text;
  if (!hint) return undefined;

  const textBlocks = blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
  let sourceLength = 0;
  for (const block of textBlocks) {
    sourceLength += block.text.length;
    if (sourceLength > MAX_QUOTABLE_SOURCE_LENGTH) return undefined;
  }

  for (const block of textBlocks) {
    const visible = (
      format === "markdown" ? visibleTextFromMarkdown(block.text) : block.text
    ).normalize("NFC");
    const canonical = normalizeWithOffsets(visible);
    const match = canonical.text.indexOf(hint);
    if (match < 0) continue;

    const start = canonical.starts[match];
    const end = canonical.ends[match + hint.length - 1];
    if (start === undefined || end === undefined) continue;
    // The cleaned slice can exceed the cap when the hint collapsed whitespace
    // runs; cap rather than drop, matching capture-time truncation.
    return truncateReplyQuote(cleanVisibleExcerpt(visible.slice(start, end)));
  }
  return undefined;
}

/** A compact server-owned preview; text takes priority over cards and attachments. */
export function messageReplyExcerpt(blocks: MessageBlock[], role: string): string {
  for (const block of [
    ...blocks.filter((block) => block.kind === "text"),
    ...blocks.filter((block) => block.kind === "channel_message"),
    ...blocks.filter(isQuestionAskBlock),
    ...blocks.filter(
      (block) =>
        block.kind !== "text" && block.kind !== "channel_message" && !isQuestionAskBlock(block),
    ),
  ]) {
    const source = replyBlockText(block).slice(0, MAX_QUOTABLE_SOURCE_LENGTH);
    const visible =
      block.kind === "text" && role !== "user" ? visibleTextFromMarkdown(source) : source;
    const excerpt = compactReplyExcerpt(visible);
    if (excerpt) return excerpt;
  }
  return "";
}

function replyBlockText(block: MessageBlock): string {
  switch (block.kind) {
    case "text":
    case "ask":
    case "channel_message":
    case "computer":
    case "meta":
    case "progress":
    case "handoff":
    case "bot_message_sent":
    case "bot_message_received":
      return block.text;
    case "choice":
      return block.question;
    case "card":
      return block.lines.map((line) => `${line.k}: ${line.v}`).join(", ");
    case "steps":
      return block.steps.map((step) => step.label).join(", ");
    case "voice_call":
    case "cloud_agent":
    case "page":
      return block.title;
    case "call_request":
      return block.reason;
    case "subagent":
      return block.name || block.task;
    case "child_bot":
    case "skill_draft":
    case "connect":
    case "app_connect":
    case "mcp_approval":
    case "chart":
      return block.name;
    case "app":
      return block.server;
    case "import_setup":
      if (block.undone) return "";
      return block.items.map((item) => ("name" in item ? item.name : item.title)).join(", ");
    case "image":
    case "file":
      return block.name || blocksToAgentHistoryText([block]);
    case "delivery":
      return "";
  }
}

/** A message that is only page cards: replies to it name the page rather than quote its text. */
export function isPageCardMessage(blocks: readonly { kind: string }[]): boolean {
  return blocks.length > 0 && blocks.every((block) => block.kind === "page");
}

/** UI previews keep attachment labels separate from agent-history descriptions. */
export function messageReplyPreview(
  blocks: MessageBlock[],
  role: ReplyPreview["role"],
  botId?: string,
  author?: ReplyPreview["author"],
): ReplyPreview {
  // A delivery's prompt and files stay hidden, even from a reply to it.
  if (isDeliveryMessage(blocks)) return { role, botId, ...(author ? { author } : {}), text: "" };
  const attachment = replyAttachment(blocks);
  const caption = messageReplyExcerpt(
    blocks.filter((block) => block.kind !== "image" && block.kind !== "file"),
    role,
  );
  const text = caption || (attachment?.kind === "file" ? attachment.name : "");
  const page = isPageCardMessage(blocks);
  return {
    role,
    botId,
    ...(author ? { author } : {}),
    text,
    ...(attachment ? { attachment } : {}),
    ...(page ? { page } : {}),
  };
}

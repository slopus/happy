import type { MessageBlock } from "@rakazo/contracts";

/** Exact token a silent run must emit as its entire final assistant reply. */
export const NO_RESPONSE = "NO_RESPONSE";

function textBlocksOf(
  blocks: readonly MessageBlock[],
): Array<Extract<MessageBlock, { kind: "text" }>> {
  return blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
}

function joinedText(blocks: readonly MessageBlock[]): string {
  return textBlocksOf(blocks)
    .map((block) => block.text)
    .join("");
}

/**
 * The sentinel alone, once or repeated. Text segments of one turn are joined
 * with no separator, so a model that re-emits the sentinel after each tool
 * batch yields `NO_RESPONSENO_RESPONSE`; that is still a silent reply, not prose.
 */
const SENTINEL_ONLY = /^(?:NO_RESPONSE\s*)+$/;

/** True when trimmed text is only the silent-reply sentinel, once or repeated. Extra prose does not match. */
export function isExactNoResponse(text: string): boolean {
  return SENTINEL_ONLY.test(text.trim());
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/**
 * Edge runs of the sentinel, glued or spaced. Each token must end at a word
 * boundary to count: a token that continues into an identifier such as
 * `NO_RESPONSE_POLICY` is a word, so the run stops at the last clean token
 * before it instead of being abandoned altogether.
 */
function proseRange(text: string): { start: number; end: number } {
  let cursor = text.length - text.trimStart().length;
  let start = 0;
  while (text.startsWith(NO_RESPONSE, cursor)) {
    cursor += NO_RESPONSE.length;
    if (!IDENTIFIER_CHAR.test(text[cursor] ?? "")) {
      while (cursor < text.length && WHITESPACE.test(text[cursor]!)) cursor++;
      start = cursor;
    } else if (!text.startsWith(NO_RESPONSE, cursor)) {
      break;
    }
  }
  // Scan backwards from the end so long whitespace cannot cause suffix backtracking.
  cursor = text.trimEnd().length;
  let end = text.length;
  while (cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor)) {
    cursor -= NO_RESPONSE.length;
    if (cursor <= start || !IDENTIFIER_CHAR.test(text[cursor - 1] ?? "")) {
      while (cursor > start && WHITESPACE.test(text[cursor - 1]!)) cursor--;
      end = cursor;
    } else if (!(cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor))) {
      break;
    }
  }
  return { start, end };
}

/**
 * Silent-reply stripper. If the trimmed final text is exactly `NO_RESPONSE`,
 * drop that text so the run can finish with no chat bubble. Sibling tool/step
 * blocks do not count as extra prose. Surrounding words keep the reply; only a
 * stray sentinel at the start or end of that prose is removed from it.
 */
export function stripNoResponseReply(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const verdict = noResponseVerdict(assembled, blocks);
  if (verdict === "prose") return withoutStraySentinelsAtEdges(assembled, blocks);
  // Fail closed: extra prose in either the assembled final or a text block keeps the reply.
  if (verdict === "mixed") return { assembled, blocks };
  return {
    assembled: "",
    blocks: blocks.filter((block) => block.kind !== "text"),
  };
}

/** True when the whole reply is the silent sentinel, as opposed to empty or a reply with prose. */
export function isNoResponseReply(assembled: string, blocks: MessageBlock[]): boolean {
  return noResponseVerdict(assembled, blocks) === "silent";
}

function noResponseVerdict(
  assembled: string,
  blocks: MessageBlock[],
): "silent" | "mixed" | "prose" {
  const assembledTrimmed = assembled.trim();
  const blockText = joinedText(blocks).trim();
  if (!isExactNoResponse(assembledTrimmed || blockText)) return "prose";
  return assembledTrimmed && blockText && !isExactNoResponse(blockText) ? "mixed" : "silent";
}

// Whitespace and invisible format characters (zero-width space and joiners, byte-order mark).
const INVISIBLE = /[\s\p{Cf}]/gu;

/**
 * A reply that only looks like one: nothing but whitespace and invisible characters, or a lone
 * dot or ellipsis. It is what a model leaves when it means to say nothing. Any letter, digit,
 * emoji or other mark ("✓", "—") is a reply. Entirely empty text is not a placeholder.
 */
export function isPlaceholderText(text: string): boolean {
  if (text.length === 0) return false;
  return /^[.…]*$/u.test(text.replace(INVISIBLE, ""));
}

/** A reply made only of placeholder characters; an entirely empty one is not. */
export function isPlaceholderReply(assembled: string, blocks: MessageBlock[]): boolean {
  return isPlaceholderText(assembled || joinedText(blocks));
}

/**
 * True while text could still grow into the sentinel, so a live view can wait before showing
 * it. Whitespace between repeats is ignored.
 */
export function couldBecomeNoResponse(text: string): boolean {
  const rest = text.replace(/\s+/g, "").replace(/^(?:NO_RESPONSE)+/, "");
  return NO_RESPONSE.startsWith(rest);
}

/**
 * For runs that must reply: drop stray sentinels at the edges of a reply with
 * prose, such as one a late follow-up message adds after the final answer.
 * A sentinel-only reply is left as is, so the run still says something.
 */
export function stripStrayNoResponse(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const visible = assembled.trim() || joinedText(blocks).trim();
  if (isExactNoResponse(visible)) return { assembled, blocks };
  return withoutStraySentinelsAtEdges(assembled, blocks);
}

/** What a bot asked by another bot returns when it answers with only the sentinel. */
export const PEER_NOTHING_NEW_REPLY = "Nothing new to add.";

/**
 * For a request or question from another bot: a sentinel-only reply would reach the
 * asker as the literal token, so say it in words instead. Other replies are handled as above.
 */
export function peerReplyWithoutSentinel(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const visible = assembled.trim() || joinedText(blocks).trim();
  if (!isExactNoResponse(visible)) return stripStrayNoResponse(assembled, blocks);
  return {
    assembled: PEER_NOTHING_NEW_REPLY,
    blocks: [
      ...blocks.filter((block) => block.kind !== "text"),
      { kind: "text", text: PEER_NOTHING_NEW_REPLY },
    ],
  };
}

/** A reply with prose stays a reply; a sentinel misplaced at its edge is dropped from what the user sees. */
function withoutStraySentinelsAtEdges(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledRange = proseRange(assembled);
  const cleanedAssembled = assembled.slice(assembledRange.start, assembledRange.end);
  const blockText = joinedText(blocks);
  const { start, end } = proseRange(blockText);
  if (start === 0 && end === blockText.length) {
    return { assembled: cleanedAssembled, blocks };
  }

  let offset = 0;
  const cleanedBlocks = blocks.flatMap<MessageBlock>((block) => {
    if (block.kind !== "text") return [block];
    const blockStart = offset;
    offset += block.text.length;
    const text = block.text.slice(Math.max(0, start - blockStart), Math.max(0, end - blockStart));
    if (text === block.text) return [block];
    return text ? [{ ...block, text }] : [];
  });
  return { assembled: cleanedAssembled, blocks: cleanedBlocks };
}

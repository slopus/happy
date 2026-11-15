import type { MessageBlock } from "@rakazo/contracts";

const PAGE_ID = /^\(page:([A-Za-z0-9_-]{1,64})\)/;
// Markdown escapes only ASCII punctuation; any other backslash is part of the title.
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * Backtick runs and tilde fences, each with where its closer ends: the next run of the same
 * length for a code span, the next fence line of its character at least as long, with nothing after it, for a block. Built in one pass from the end,
 * so finding closers never rescans the text. `skipTo[at]` is where a run starting at `at` leaves
 * off: past its closer, to the end for an unclosed fence, or past itself for a lone span.
 */
function codeSkips(text: string): Int32Array {
  const starts: number[] = [];
  const ends: number[] = [];
  const fences: boolean[] = [];
  // Only a fence line with nothing but spaces after it can close a block; text after it opens one.
  const closes: boolean[] = [];
  let lineStart = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text.charCodeAt(at);
    if (char === 10) lineStart = at + 1;
    if ((char !== 96 && char !== 126) || text.charCodeAt(at - 1) === char) continue;
    let end = at + 1;
    while (text.charCodeAt(end) === char) end++;
    const fence = end - at >= 3 && at - lineStart <= 3 && text.slice(lineStart, at).trim() === "";
    // Tildes mark only fences; a shorter run is plain text.
    if (char === 126 && !fence) continue;
    starts.push(at);
    ends.push(end);
    fences.push(fence);
    let rest = end;
    if (fence) while (text[rest] === " " || text[rest] === "\t") rest++;
    const after = text.charCodeAt(rest);
    closes.push(fence && (rest === text.length || after === 10 || after === 13));
  }
  const skipTo = new Int32Array(text.length);
  const nextOfLength = new Map<number, number>();
  // Later fences, nearest on top, each longer than every fence above it: a shorter one behind a
  // nearer fence at least as long can close no earlier fence, so it leaves for good.
  const laterFences: Record<string, number[]> = { "`": [], "~": [] };
  const fenceLength = (index: number) => ends[index]! - starts[index]!;
  for (let index = starts.length - 1; index >= 0; index--) {
    const length = ends[index]! - starts[index]!;
    let closer = -1;
    if (fences[index]) {
      const later = laterFences[text[starts[index]!]!]!;
      if (closes[index]) {
        while (later.length && fenceLength(later.at(-1)!) < length) later.pop();
        closer = later.at(-1) ?? -1;
        later.push(index);
      } else {
        // It closes nothing, so it keeps every later fence for earlier ones: the lengths only grow
        // down the stack, so the nearest long enough is found by halving.
        let low = 0;
        let high = later.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (fenceLength(later[middle]!) >= length) low = middle + 1;
          else high = middle;
        }
        closer = low > 0 ? later[low - 1]! : -1;
      }
    } else closer = nextOfLength.get(length) ?? -1;
    nextOfLength.set(length, index);
    skipTo[starts[index]!] =
      closer >= 0 ? ends[closer]! : fences[index] ? text.length : ends[index]!;
  }
  return skipTo;
}

/**
 * `[title](page:<id>)` links as their titles, in one linear pass so no input can make it slow.
 * Code spans and fenced blocks are left as written.
 */
export function pageLinksAsTitles(text: string): string {
  const skips = text.includes("`") || text.includes("~~~") ? codeSkips(text) : null;
  let out = "";
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "`" || char === "~") {
      // A backtick or tilde after an escape, inside a run or not opening a fence, is plain text.
      at = skips?.[at] || at + 1;
      continue;
    }
    if (char !== "[") {
      at += 1;
      continue;
    }
    let end = at + 1;
    let title = "";
    let closed = false;
    while (end < text.length) {
      const next = text[end]!;
      if (next === "\\" && ESCAPABLE.test(text[end + 1] ?? "")) {
        title += text[end + 1];
        end += 2;
      } else if (next === "]") {
        closed = true;
        break;
      } else if (next === "[" || next === "\n") {
        break;
      } else {
        title += next;
        end += 1;
      }
    }
    const link = closed ? PAGE_ID.exec(text.slice(end + 1, end + 2 + 6 + 64 + 1)) : null;
    if (link) {
      out += text.slice(copied, at) + title;
      at = end + 1 + link[0].length;
      copied = at;
    } else {
      at = closed ? end + 1 : end;
    }
  }
  return out + text.slice(copied);
}

/** Each page once, first place kept: a list that shifted between reads can repeat one. */
export function uniquePages<T extends { id: string }>(pages: readonly T[]): T[] {
  const seen = new Set<string>();
  return pages.filter((page) => !seen.has(page.id) && Boolean(seen.add(page.id)));
}

/**
 * Each page's newest card in a thread, as `messageId:version`. `ownerOf` names the message a
 * card is drawn under where page-only messages fold into the reply after them.
 */
export function newestPageCards(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  ownerOf: (messageId: string) => string = (id) => id,
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "page")
        newest.set(block.pageId, `${ownerOf(message.id)}:${block.version}`);
    }
  }
  return newest;
}

/**
 * Whether a later card in the same thread shows this page, so this one reads "Updated below".
 * A newer version saved with no card here, such as a routine's refresh, does not count.
 */
export function pageCardSuperseded(
  newest: ReadonlyMap<string, string>,
  messageId: string,
  block: { pageId: string; version: number },
): boolean {
  const latest = newest.get(block.pageId);
  return latest !== undefined && latest !== `${messageId}:${block.version}`;
}

/** The newest card for the page: a reply to it gives the bot an id that outlives renames. */
export function pageReplyTargetId(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  pageId: string,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id.includes(":")) continue;
    if (message.blocks.some((block) => block.kind === "page" && block.pageId === pageId)) {
      return message.id;
    }
  }
  return null;
}

/**
 * A message sent about a page: a reply to its card in this chat, or a link naming the page when
 * the chat has none loaded. A reply the user picked themselves is left as they chose it.
 */
export function pageReply(
  text: string,
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  page: { id: string; title: string } | null,
  chosenReplyId?: string,
): { text: string; replyToMessageId?: string } {
  if (!page || chosenReplyId) return { text };
  const target = pageReplyTargetId(messages, page.id);
  if (target) return { text, replyToMessageId: target };
  const title = page.title.replace(/[\\[\]]/g, "\\$&");
  return { text: `[${title}](page:${page.id})\n${text}` };
}

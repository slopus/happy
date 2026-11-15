import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_MEMORY_MAX_BYTES } from "@rakazo/contracts";
import { byteLength } from "./utf8.js";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
  "reflect_memory",
]);

/** `forget_memory` and `reflect_memory` are offered only when the provider implements that optional verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
  semanticMemoryReflects: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter(
        (tool) =>
          (semanticMemoryForgets || tool.name !== "forget_memory") &&
          (semanticMemoryReflects || tool.name !== "reflect_memory"),
      )
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}

export type MemoryEdit = { content: string } | { error: string; entries: string[] };

/**
 * Adds a fact, or with `oldText` replaces (or, given an empty fact, removes) the
 * lines holding its one match. A save that would grow the document past the cap
 * is refused with the entries, so the bot consolidates instead of losing notes.
 */
export function editMemory(
  existing: string,
  fact: string,
  oldText = "",
  maxBytes = BOT_MEMORY_MAX_BYTES,
): MemoryEdit {
  const target = oldText.trim().replace(/\r\n/g, "\n");
  let content = existing;
  if (!target) {
    content = appendMemoryFact(existing, fact);
  } else {
    const current = existing.replace(/\r\n/g, "\n");
    // An entry is the line or lines a match touches, so repeats within one line count once.
    const starts = new Set<number>();
    for (let at = current.indexOf(target); at !== -1; at = current.indexOf(target, at + 1))
      starts.add(current.lastIndexOf("\n", at - 1) + 1);
    if (starts.size !== 1) {
      const firstLine = target.split("\n")[0]!;
      return {
        error:
          starts.size === 0
            ? "No entry contains old_text. Copy it exactly from one of these entries."
            : "old_text matches more than one entry. Quote more of the one to change.",
        entries: entriesOf(current).filter((line) => starts.size === 0 || line.includes(firstLine)),
      };
    }
    const index = current.indexOf(target);
    const start = [...starts][0]!;
    const lineEnd = current.indexOf("\n", index + target.length);
    const end = lineEnd === -1 ? current.length : lineEnd;
    const next = fact.trim().replace(/\r\n/g, "\n");
    content = next
      ? `${current.slice(0, start)}${next}${current.slice(end)}`
      : `${current.slice(0, start)}${current.slice(lineEnd === -1 ? end : end + 1)}`;
  }
  const bytes = byteLength(content);
  if (bytes > maxBytes && bytes > byteLength(existing)) {
    return {
      error: `Memory is full (${maxBytes} bytes). Make room by merging, shortening or removing entries with old_text, then save again.`,
      entries: entriesOf(existing),
    };
  }
  return { content };
}

function entriesOf(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
}

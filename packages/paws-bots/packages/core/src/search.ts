import type { SearchHit } from "@rakazo/contracts";
import { textBoundary, truncatePlainText } from "./markdown-plain.js";

const URL_PATTERN = /https?:\/\/[^\s<>"'`\]][^\s<>"'`]*/gi;

const URL_START = /https?:\/\/[^\s<>"'`\]]/gi;

function linkEnd(text: string, start: number, limit: number): number {
  let parentheses = 0;
  let brackets = 0;
  for (let i = start; i < limit; i++) {
    if (text[i] === "(") parentheses += 1;
    else if (text[i] === ")" && --parentheses < 0) return i;
    else if (text[i] === "[") brackets += 1;
    else if (text[i] === "]" && --brackets < 0) return i;
  }
  return limit;
}

function findLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const limit = match.index + match[0].length;
    let start = match.index;
    while (start < limit) {
      const end = linkEnd(text, start, limit);
      links.push(text.slice(start, end).replace(/[.,;:!?]+$/, ""));
      URL_START.lastIndex = end;
      start = URL_START.exec(text)?.index ?? limit;
    }
  }
  return links;
}

export function extractLinksFromText(text: string): string[] {
  return [...new Set(findLinks(text))];
}

export function matchesSearchQuery(
  query: string,
  ...fields: Array<string | undefined | null>
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

/**
 * Escape the characters a SQL `LIKE` pattern treats as wildcards, so a search
 * matches the text the user typed. `matchesSearchQuery` compares literally:
 * without this a `%` or `_` would widen the match, and a `\` would swallow the
 * character after it.
 */
export function escapeSearchWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Escape string content as rendered in JSONB text, then escape SQL LIKE wildcards. */
export function escapeJsonSearchWildcards(value: string): string {
  return escapeSearchWildcards(JSON.stringify(value).slice(1, -1));
}

/**
 * A snippet that would open mid-word ("…nd code") opens at the next word instead, when one starts
 * soon enough to keep the context before the match.
 */
function wordStart(text: string, start: number, match: number): number {
  if (start === 0 || /\s/.test(text[start - 1] ?? "") || /\s/.test(text[start] ?? "")) return start;
  const space = text.slice(start, Math.min(start + 15, match)).search(/\s/);
  return space < 0 ? start : start + space + 1;
}

/** 按 UTF-16 长度生成搜索摘要，保持原有匹配逻辑并避免在边界切断代理对。 */
export function snippetAroundMatch(text: string, query: string, maxLen = 120): string {
  const q = query.trim().toLowerCase();
  if (!q) return truncatePlainText(text, maxLen);
  const lower = text.toLowerCase();
  const index = lower.indexOf(q);
  if (index < 0) return truncatePlainText(text, maxLen);
  let originalIndex = index;
  if (lower.length !== text.length) {
    // Lowercasing can expand a character (İ → i + combining dot).
    // Map the match back to the original UTF-16 offset before slicing.
    let lowerOffset = 0;
    originalIndex = 0;
    for (const character of text) {
      const lowerLength = character.toLowerCase().length;
      if (lowerOffset + lowerLength > index) break;
      lowerOffset += lowerLength;
      originalIndex += character.length;
    }
  }
  const start = wordStart(text, textBoundary(text, Math.max(0, originalIndex - 40)), originalIndex);
  const end = textBoundary(text, Math.min(text.length, start + maxLen));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export type SearchThreadTarget =
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined };

export function searchHitThreadTarget(hit: {
  botId?: string;
  groupId?: string;
}): SearchThreadTarget {
  if (Boolean(hit.botId) === Boolean(hit.groupId)) {
    throw new Error("Search hit must target exactly one of a bot or group");
  }
  return hit.groupId ? { groupId: hit.groupId } : { botId: hit.botId! };
}

/**
 * One row per hit, unique per kind and every id. File hits carry the message they were sent in,
 * so files sent together share a message id; links in one message differ only by URL.
 */
export function searchHitListKey(hit: SearchHit): string {
  return [
    hit.kind,
    hit.groupId ?? hit.botId ?? "",
    hit.messageId ?? "",
    hit.artifactId ?? "",
    hit.routineId ?? "",
    hit.url ?? "",
  ].join("\u0000");
}

export function dedupeSearchHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of hits) {
    const key = searchHitListKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

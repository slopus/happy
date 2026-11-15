import { createHash } from "node:crypto";
import type { AgentContextStrategy, CacheCapabilities } from "@rakazo/adapter-kit";
import {
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  shortenedTextLength,
  textBoundary,
  truncatePlainText,
  VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
} from "@rakazo/core";
import type { VerbatimMcpServers } from "./verbatim-mcp-result.js";
import { isVerbatimMcpResult, toolCallIdentity } from "./verbatim-mcp-result.js";

export type ContextStrategy = AgentContextStrategy;
export interface ContextMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  sections?: Record<string, string | null>;
  toolsAdded?: unknown;
  toolsRemoved?: unknown;
}
export interface ContextBudget {
  contextWindow: number;
  outputReserve: number;
  systemPrompt: string;
  tools: unknown;
  /** Additional instructions, snapshots, retrieved passages or task state outside messages. */
  extraContext?: string;
  /** Adapter-specific image planning estimate. Images without one count their serialized bytes. */
  imageTokens?: number | ((image: object) => number | undefined);
}
export interface ContextSelectionOptions {
  budget: ContextBudget;
  strategy: ContextStrategy;
  /** Never drop current request, steering, approvals or authoritative constraints. */
  protectedIndexes?: readonly number[];
  recentExchanges?: number;
  /**
   * Exchanges older than recentExchanges stay while the messages before index `before`, where
   * the current request starts, fit `tokens`.
   */
  earlier?: { before: number; tokens: number };
  cacheWarmth?: "likely-warm" | "likely-cold" | "unknown";
  /** Keep tool protocol intact while shortening oversized result bodies. */
  truncateToolResults?: boolean;
  /** Servers that asked to keep tool results whole. Those results are never cut. */
  verbatimMcpServers?: VerbatimMcpServers;
}
export class ContextBudgetError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly availableTokens: number,
    /** Instructions and tools alone fill the window, so no conversation can fit. */
    modelTooSmall = false,
    message?: string,
  ) {
    super(
      message ??
        (modelTooSmall
          ? MODEL_CONTEXT_TOO_SMALL_ERROR
          : "Required context exceeds the model context budget"),
    );
    this.name = "ContextBudgetError";
  }
}
function imageBlocks(value: unknown): object[] {
  const found: object[] = [];
  const visitMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    if (
      "role" in message &&
      (message.role === "user" || message.role === "toolResult") &&
      "content" in message &&
      Array.isArray(message.content)
    ) {
      for (const part of message.content) {
        if (part && typeof part === "object" && "type" in part && part.type === "image")
          found.push(part);
      }
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && "type" in item && item.type === "image")
        found.push(item);
      else visitMessage(item);
    }
  } else if (
    value &&
    typeof value === "object" &&
    "messages" in value &&
    Array.isArray(value.messages)
  ) {
    for (const message of value.messages) visitMessage(message);
  } else visitMessage(value);
  return found;
}
/** Deliberately low count, about five characters a token, for text that must never be overcharged. */
export function lowTextTokens(text: string): number {
  return Math.floor(text.length / 5);
}

/**
 * Provider-neutral token estimate for text, without a tokenizer. The weights were calibrated
 * against cl100k, o200k, Llama 3, Qwen 2.5 and Mistral's original tokenizer, landing at or a
 * little above the least efficient of them for prose, code, JSON, IDs and non-Latin scripts:
 * about 3.3 ASCII characters per token (English prose is nearer 4.5), one token per digit and
 * per camelCase or letter-digit boundary (IDs, hashes, base64), 0.6 per accented Latin, Greek
 * or Cyrillic letter, and 1.25 per UTF-16 unit of other scripts and emoji. Byte-level
 * tokenizers never exceed one token per UTF-8 byte, so that bounds the estimate.
 */
export function estimateTextTokens(text: string): number {
  let total = 0;
  let previous = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // 1 lowercase, 2 uppercase, 3 digit, 0 anything else.
    const kind =
      code >= 97 && code <= 122
        ? 1
        : code >= 65 && code <= 90
          ? 2
          : code >= 48 && code <= 57
            ? 3
            : 0;
    if (code >= 128) total += code < 0x0590 ? 0.6 : 1.25;
    else if (kind === 3) total += 1;
    else if (kind === 0 && code > 32 && code < 127) total += 0.4;
    else total += 0.3;
    if (
      (previous === 1 && kind === 2) ||
      (previous === 3 && (kind === 1 || kind === 2)) ||
      ((previous === 1 || previous === 2) && kind === 3)
    )
      total += 1;
    previous = kind;
  }
  return Math.min(Math.ceil(total), Buffer.byteLength(text, "utf8"));
}
/** Text estimate plus framing. Actual user/tool image blocks receive an adapter estimate;
 * images without one keep a serialized byte count, and image-shaped tool arguments remain text.
 */
export function estimateContextTokens(
  value: unknown,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  const images = new Set<object>();
  let imageTotal = 0;
  for (const image of imageBlocks(value)) {
    const estimate =
      imageTokens === undefined
        ? undefined
        : typeof imageTokens === "number"
          ? imageTokens
          : imageTokens(image);
    images.add(image);
    imageTotal +=
      estimate !== undefined && Number.isFinite(estimate) && estimate > 0
        ? estimate
        : Buffer.byteLength(JSON.stringify(image), "utf8");
  }
  const serialized =
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && images.has(item) ? { type: "image" } : item,
    ) ?? "";
  return estimateTextTokens(serialized) + imageTotal + 16;
}
function fixedTokens(budget: ContextBudget): number {
  for (const value of [
    budget.contextWindow,
    budget.outputReserve,
    typeof budget.imageTokens === "number" ? budget.imageTokens : 0,
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid context budget");
  }
  if (typeof budget.imageTokens === "number" && budget.imageTokens < 1)
    throw new Error("Invalid image token bound");
  return (
    estimateContextTokens(budget.systemPrompt) +
    estimateContextTokens(budget.tools) +
    (budget.extraContext ? estimateContextTokens(budget.extraContext) : 0)
  );
}
interface HistoryTextReference {
  text: string;
  textOffset: number;
  nextTextOffset: number | null;
  truncated: boolean;
}
function shortenHistoryResult(
  content: unknown,
  size: number,
  tool: { name?: string; arguments?: unknown },
): string | undefined {
  if (tool.name !== "read_history" && tool.name !== "search_history") return;
  const source =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
        ? content[0].text
        : undefined;
  if (typeof source !== "string") return;
  let payload: {
    untrusted?: boolean;
    messages: HistoryTextReference[];
    runs?: Array<{ outcomes?: HistoryTextReference[] }>;
    snapshots?: Array<{ topic?: string; outcome?: string }>;
    contextTruncated?: boolean;
  };
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  if (payload?.untrusted !== true || !Array.isArray(payload.messages)) return;
  const refs: HistoryTextReference[] = [
    ...payload.messages,
    ...(Array.isArray(payload.runs)
      ? payload.runs.flatMap((run) => (Array.isArray(run?.outcomes) ? run.outcomes : []))
      : []),
  ].filter((ref) => typeof ref?.text === "string" && Number.isInteger(ref.textOffset));
  // Snapshot text is only navigation; original reference offsets retain exact evidence.
  for (const snapshot of Array.isArray(payload.snapshots) ? payload.snapshots : []) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (typeof snapshot.topic === "string") snapshot.topic = truncatePlainText(snapshot.topic, 80);
    if (typeof snapshot.outcome === "string")
      snapshot.outcome = truncatePlainText(snapshot.outcome, 80);
  }
  payload.contextTruncated = true;
  let encoded = JSON.stringify(payload);
  while (encoded.length > size) {
    const longest = refs.reduce<HistoryTextReference | undefined>(
      (best, ref) =>
        shortenedTextLength(ref.text) > 0 && (!best || ref.text.length > best.text.length)
          ? ref
          : best,
      undefined,
    );
    if (!longest) {
      return JSON.stringify({
        untrusted: true,
        contextTruncated: true,
        needsRetry: true,
        error:
          "History metadata does not fit. Retry the same request with limit 1; no evidence or paging cursor was consumed.",
        retry: {
          ...(tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {}),
          limit: 1,
        },
      });
    }
    longest.text = longest.text.slice(0, shortenedTextLength(longest.text));
    longest.nextTextOffset = longest.textOffset + longest.text.length;
    longest.truncated = true;
    encoded = JSON.stringify(payload);
  }
  return encoded;
}
/**
 * A result cut before the model read it is missing evidence. A result cut after the model read
 * it is not: saying "unavailable" there makes a model retract statements it made from it.
 */
const OMITTED_BEFORE_USE =
  "[Tool result truncated to fit context; omitted evidence is unavailable.]";
const OMITTED_TEXT_BEFORE_USE =
  "[Tool result truncated to fit context; inspect original evidence before claiming omitted details.]";
const OMITTED_AFTER_USE =
  "[Earlier result shortened after you read it; statements made from it stand. Re-run the tool only if you need the omitted text.]";

/** Keep control fields and JSON shape while marking omitted long evidence strings. */
function shortenStructuredResult(
  source: string,
  size: number,
  marker = OMITTED_BEFORE_USE,
): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  const holder: Record<string, unknown> = { payload };
  const leaves: Array<{ parent: Record<string, unknown> | unknown[]; key: string | number }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // IDs, cursors and routing/action metadata must remain usable exactly as returned.
      if (
        typeof child === "string" &&
        !/(?:id|cursor|token|url|path|name|status|type|query)$/i.test(key)
      )
        leaves.push({ parent: value as Record<string, unknown>, key });
      else if (child && typeof child === "object") visit(child);
    }
  };
  if (typeof payload === "string") leaves.push({ parent: holder, key: "payload" });
  else visit(payload);
  if (payload && typeof payload === "object" && !Array.isArray(payload))
    (payload as Record<string, unknown>).contextTruncated = true;
  // Re-encoding the whole payload and rescanning every leaf per cut blocked the event loop for
  // tens of seconds on large connector results, so track the length and the longest leaf instead.
  let encodedLength = JSON.stringify(holder.payload).length;
  const leafText = (index: number) =>
    (leaves[index]!.parent as Record<string, unknown>)[leaves[index]!.key] as string;
  const longest = new LongestFirst(
    leaves.flatMap((_, index) =>
      leafText(index).length > 128 ? [[index, leafText(index).length] as const] : [],
    ),
  );
  while (encodedLength > size) {
    const index = longest.peek();
    if (index === undefined) break; // Required metadata alone may still need explicit budget failure.
    const value = leafText(index);
    // Keep a quarter at each end when that still shrinks the field. Otherwise size the ends net
    // of the marker, so each pass on a medium-length field halves what is left to cut.
    const preferredKeep = Math.max(8, Math.floor(value.length / 4));
    const keep =
      2 * preferredKeep + marker.length + 2 < value.length
        ? preferredKeep
        : Math.floor((value.length - marker.length) / 4);
    if (keep < 1) break;
    const shortened = `${value.slice(0, keep)}\n${marker}\n${value.slice(-keep)}`;
    if (shortened.length >= value.length) break;
    (leaves[index]!.parent as Record<string, unknown>)[leaves[index]!.key] = shortened;
    encodedLength += JSON.stringify(shortened).length - JSON.stringify(value).length;
    longest.pop();
    if (shortened.length > 128) longest.push(index, shortened.length);
  }
  return JSON.stringify(holder.payload);
}

/** Max-heap of leaf indexes by string length; ties go to the earlier leaf. */
class LongestFirst {
  private readonly heap: Array<readonly [index: number, length: number]> = [];

  constructor(entries: ReadonlyArray<readonly [index: number, length: number]>) {
    for (const [index, length] of entries) this.push(index, length);
  }

  peek(): number | undefined {
    return this.heap[0]?.[0];
  }

  push(index: number, length: number) {
    const heap = this.heap;
    heap.push([index, length]);
    for (let child = heap.length - 1; child > 0; ) {
      const parent = (child - 1) >> 1;
      if (!this.before(child, parent)) break;
      [heap[child], heap[parent]] = [heap[parent]!, heap[child]!];
      child = parent;
    }
  }

  pop() {
    const heap = this.heap;
    const last = heap.pop();
    if (!last || heap.length === 0) return;
    heap[0] = last;
    for (let parent = 0; ; ) {
      let first = parent;
      for (const child of [2 * parent + 1, 2 * parent + 2])
        if (child < heap.length && this.before(child, first)) first = child;
      if (first === parent) return;
      [heap[first], heap[parent]] = [heap[parent]!, heap[first]!];
      parent = first;
    }
  }

  private before(a: number, b: number) {
    const [indexA, lengthA] = this.heap[a]!;
    const [indexB, lengthB] = this.heap[b]!;
    return lengthA > lengthB || (lengthA === lengthB && indexA < indexB);
  }
}

/**
 * MCP results put JSON in a text content part (sometimes beside other parts). Treating that inner
 * JSON as one prose leaf cuts IDs and cursors out of it, so shorten JSON text parts with their own
 * control-preserving rules, shrink sibling parts and outer metadata the same way, and re-wrap.
 * Non-JSON envelopes fall through to the generic path.
 */
function isJsonTextPart(part: { type?: string; text?: unknown } | undefined): part is {
  type: "text";
  text: string;
} {
  if (part?.type !== "text" || typeof part.text !== "string") return false;
  const trimmed = part.text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(part.text);
    return true;
  } catch {
    return false;
  }
}

function shortenMcpEnvelope(source: string, size: number, marker: string): string | undefined {
  let payload: { content?: Array<{ type?: string; text?: unknown }> } & Record<string, unknown>;
  try {
    payload = JSON.parse(source);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const originalParts = payload.content;
  if (!Array.isArray(originalParts) || !originalParts.some(isJsonTextPart)) return;

  const wrap = (nextParts: typeof originalParts) =>
    JSON.stringify({ ...payload, content: nextParts });

  // Shrink outer metadata first so the inner budget is not crushed by a large _meta blob.
  const outer = { ...payload };
  delete outer.content;
  delete outer.structuredContent;
  let outerSource = JSON.stringify(outer);
  if (outerSource.length > Math.max(64, Math.floor(size / 4))) {
    const shortenedOuter = shortenStructuredResult(
      outerSource,
      Math.max(64, Math.floor(size / 4)),
      marker,
    );
    if (shortenedOuter !== undefined) {
      Object.assign(payload, JSON.parse(shortenedOuter));
      if (shortenedOuter !== outerSource) payload.contextTruncated = true;
      outerSource = shortenedOuter;
    }
  }

  const structuredSource =
    payload.structuredContent === undefined ? undefined : JSON.stringify(payload.structuredContent);
  let parts = originalParts.map((part) => ({ ...part }));
  const emptyJsonShell = parts.map((part) => (isJsonTextPart(part) ? { ...part, text: "" } : part));
  let budget = Math.max(128, size - wrap(emptyJsonShell).length);
  let encoded = wrap(parts);

  for (let attempt = 0; attempt < 6 && encoded.length > size; attempt++) {
    let changed = false;
    parts = parts.map((part) => {
      if (isJsonTextPart(part)) {
        const shortened = shortenStructuredResult(part.text, budget, marker);
        if (shortened === undefined || shortened === part.text) return part;
        changed = true;
        return { ...part, text: shortened };
      }
      const serialized = JSON.stringify(part);
      if (serialized.length <= 128) return part;
      const shortened = shortenStructuredResult(
        serialized,
        Math.min(budget, Math.max(128, Math.floor(size / 4))),
        marker,
      );
      if (shortened === undefined || shortened === serialized) return part;
      try {
        const parsed = JSON.parse(shortened) as typeof part;
        if (!parsed || typeof parsed !== "object") return part;
        changed = true;
        return parsed;
      } catch {
        return part;
      }
    });
    if (structuredSource !== undefined) {
      const shortenedStructured = shortenStructuredResult(structuredSource, budget, marker);
      try {
        payload.structuredContent = JSON.parse(shortenedStructured ?? "");
        if (shortenedStructured !== structuredSource) changed = true;
      } catch {
        delete payload.structuredContent;
        changed = true;
      }
    }
    if (changed) payload.contextTruncated = true;
    encoded = wrap(parts);
    if (encoded.length <= size) break;
    if (!changed) break;
    budget = Math.max(128, Math.floor(budget * (size / encoded.length)) - 1);
  }
  // Soft target may still be exceeded by protected ids. Keep the envelope on this path even when
  // nothing could shrink: the generic shortener would cut the JSON text and drop its ids.
  return encoded;
}

/**
 * Shorten evidence cheaply while keeping structured controls and original-history offsets.
 * Pass afterUse when the model already read the result on an earlier step.
 */
export function shortenToolResultText(
  source: string,
  size: number,
  tool: { name?: string; arguments?: unknown } = {},
  options: { afterUse?: boolean } = {},
): string {
  const afterUse = options.afterUse || source.includes(OMITTED_AFTER_USE);
  const marker = afterUse ? OMITTED_AFTER_USE : OMITTED_BEFORE_USE;
  return (
    shortenHistoryResult(source, size, tool) ??
    shortenMcpEnvelope(source, size, marker) ??
    shortenStructuredResult(source, size, marker) ??
    shortenPlainText(source, size, afterUse ? OMITTED_AFTER_USE : OMITTED_TEXT_BEFORE_USE)
  );
}

/** Keep the head and tail halves of plain text around an omission marker. */
export function shortenPlainText(
  source: string,
  size: number,
  marker = OMITTED_TEXT_BEFORE_USE,
): string {
  const half = Math.floor(size / 2);
  const tail = textBoundary(source, source.length - half);
  return `${truncatePlainText(source, half)}\n${marker}\n${source.slice(tail)}`;
}
interface Group {
  indexes: number[];
  tokens: number;
}
/** A tool request and all results form an indivisible group. User exchanges may contain several groups. */
function messageGroups(
  messages: readonly ContextMessage[],
  imageTokens?: ContextBudget["imageTokens"],
): Group[] {
  const groups: Group[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      const group = groups.at(-1);
      if (!group?.indexes.some((i) => messages[i]!.role === "assistant")) {
        throw new Error("Orphaned tool result in context");
      }
      const assistant = messages[group.indexes[0]!]!;
      const calls = Array.isArray(assistant.content)
        ? assistant.content.filter(
            (item) =>
              item && typeof item === "object" && "type" in item && item.type === "toolCall",
          )
        : [];
      if (!message.toolCallId || !calls.some((call) => call.id === message.toolCallId)) {
        throw new Error("Unmatched tool result in context");
      }
      if (
        group.indexes.some(
          (previous) =>
            messages[previous]!.role === "toolResult" &&
            messages[previous]!.toolCallId === message.toolCallId,
        )
      )
        throw new Error("Duplicate tool result in context");
      group.indexes.push(index);
      group.tokens += estimateContextTokens(
        providerContextPrefix("", [], [message]).messages[0],
        imageTokens,
      );
    } else {
      groups.push({
        indexes: [index],
        tokens: estimateContextTokens(
          providerContextPrefix("", [], [message]).messages[0],
          imageTokens,
        ),
      });
    }
  }
  for (const group of groups) {
    if (messages[group.indexes[0]!]!.role !== "assistant") continue;
    const content = messages[group.indexes[0]!]!.content;
    if (!Array.isArray(content)) continue;
    for (const call of content) {
      if (
        call &&
        typeof call === "object" &&
        "type" in call &&
        call.type === "toolCall" &&
        !group.indexes.some((index) => messages[index]!.toolCallId === call.id)
      ) {
        throw new Error("Missing tool result in context");
      }
    }
  }
  return groups;
}
/** Cheap selection only. No clock event or strategy calls a model or creates a summary. */
export function selectContext<T extends ContextMessage>(
  messages: readonly T[],
  options: ContextSelectionOptions,
): {
  messages: T[];
  estimatedInputTokens: number;
  droppedMessages: number;
  truncatedToolResults: number;
  availableMessageTokens: number;
  estimation: "text-estimate";
} {
  const fixed = fixedTokens(options.budget);
  const available = Math.floor(options.budget.contextWindow - options.budget.outputReserve - fixed);
  const groups = messageGroups(messages, options.budget.imageTokens);
  // Pi can carry mandatory instructions and tool schemas in system messages.
  // A new conversation cannot make either representation fit a smaller model.
  const requiredFixed =
    fixed +
    groups
      .filter((group) => messages[group.indexes[0]!]!.role === "system")
      .reduce((total, group) => total + group.tokens, 0);
  if (requiredFixed > options.budget.contextWindow - options.budget.outputReserve) {
    throw new ContextBudgetError(
      requiredFixed,
      options.budget.contextWindow - options.budget.outputReserve,
      true,
    );
  }
  // A result followed by any assistant message has been read, with or without a later tool call.
  const latestAssistant = messages.findLastIndex((message) => message.role === "assistant");
  const protectedIndexes = new Set(options.protectedIndexes ?? []);
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") protectedIndexes.add(index);
  }
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  if (lastUser >= 0) protectedIndexes.add(lastUser);
  // Keep the unread tool step intact even when user messages follow its results.
  const latestContent = messages[latestAssistant]?.content;
  if (Array.isArray(latestContent) && latestContent.some((part) => part?.type === "toolCall"))
    protectedIndexes.add(latestAssistant);
  // Keep the final group intact. Earlier complete groups can be omitted.
  for (const index of groups.at(-1)?.indexes ?? []) protectedIndexes.add(index);
  for (const index of protectedIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= messages.length)
      throw new Error("Invalid protected context index");
  }
  const protectedGroupIndexes = new Set<number>();
  const selected = new Set<Group>();
  let used = 0;
  for (const group of groups) {
    if (group.indexes.some((index) => protectedIndexes.has(index))) {
      selected.add(group);
      for (const index of group.indexes) protectedGroupIndexes.add(index);
      used += group.tokens;
    }
  }
  if (used > available) {
    if (options.truncateToolResults !== false) {
      let shortenedCount = 0;
      let keptVerbatimWhole = false;
      const shortened = messages.map((message, index) => {
        if (!protectedGroupIndexes.has(index) || message.role !== "toolResult") return message;
        const parts = Array.isArray(message.content) ? message.content : undefined;
        const images =
          parts?.filter((part) => part && typeof part === "object" && part.type === "image") ?? [];
        const serialized = parts?.every(
          (part) =>
            part && typeof part === "object" && (part.type === "text" || part.type === "image"),
        )
          ? parts
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
          : typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        if (!serialized || serialized.length <= 256) return message;
        const group = groups.find((group) => group.indexes.includes(index));
        const assistant = group ? messages[group.indexes[0]!] : undefined;
        const nativeCall = Array.isArray(assistant?.content)
          ? assistant.content.find(
              (part) => part?.type === "toolCall" && part.id === message.toolCallId,
            )
          : undefined;
        const call = toolCallIdentity(nativeCall, message.toolName);
        if (isVerbatimMcpResult(call.name, call.arguments, options.verbatimMcpServers)) {
          keptVerbatimWhole = true;
          return message;
        }
        const size = Math.max(
          128,
          Math.min(Math.floor(serialized.length / 2), Math.floor(available / 4)),
        );
        const text = shortenToolResultText(
          serialized,
          size,
          nativeCall ?? { name: message.toolName },
          { afterUse: index < latestAssistant },
        );
        if (text.length >= serialized.length) return message;
        shortenedCount += 1;
        return { ...message, content: [{ type: "text", text }, ...images] } as T;
      });
      if (shortenedCount) {
        const retry = selectContext(shortened, options);
        return {
          ...retry,
          truncatedToolResults: Math.max(retry.truncatedToolResults, shortenedCount),
        };
      }
      if (keptVerbatimWhole) {
        // Throws the generic error when shortening the kept results would not make it fit either.
        selectContext(messages, { ...options, verbatimMcpServers: undefined });
        throw new ContextBudgetError(
          used + fixed,
          options.budget.contextWindow - options.budget.outputReserve,
          false,
          VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
        );
      }
    }
    throw new ContextBudgetError(
      used + fixed,
      options.budget.contextWindow - options.budget.outputReserve,
      available <= 0,
    );
  }
  const keepPrefix =
    options.strategy === "current" ||
    (options.strategy === "cache-aware" && options.cacheWarmth === "likely-warm");
  const exchangeLimit = keepPrefix
    ? Number.POSITIVE_INFINITY
    : Math.max(1, options.recentExchanges ?? 8);
  let exchanges = 0;
  // Active tool progress never counts against the earlier allowance, so the retained start
  // holds during a run.
  const currentStart = options.earlier?.before ?? 0;
  let earlierTokens = 0;
  // Retain a contiguous recent suffix. Skip no holes inside a retained tool group.
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group.indexes.some((i) => messages[i]!.role === "user")) exchanges += 1;
    if (selected.has(group)) continue;
    const earlier = group.indexes[0]! < currentStart;
    if (
      exchanges > exchangeLimit &&
      (!earlier || earlierTokens + group.tokens > (options.earlier?.tokens ?? 0))
    )
      break;
    if (used + group.tokens > available) break;
    selected.add(group);
    used += group.tokens;
    if (earlier) earlierTokens += group.tokens;
  }
  const selectedIndexes = new Set([...selected].flatMap((group) => group.indexes));
  return {
    messages: messages.filter((_message, index) => selectedIndexes.has(index)),
    estimatedInputTokens: fixed + used,
    droppedMessages: messages.length - selectedIndexes.size,
    truncatedToolResults: 0,
    availableMessageTokens: available,
    estimation: "text-estimate" as const,
  };
}

export interface CacheRequest {
  /** Opaque server-side scope including provider account/routing identity. Never sent in prompts. */
  accountScope: string;
  connectionId: string;
  modelId: string;
  prefix: unknown;
  prefixTokens: number;
  capabilities?: CacheCapabilities;
  /** Tracker-clock request start, kept outside the provider payload and prefix identity. */
  startedAt?: number;
}
export function providerContextPrefix<T extends ContextMessage>(
  systemPrompt: string,
  tools: unknown,
  messages: readonly T[],
) {
  return {
    systemPrompt,
    tools,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.sections ? { sections: message.sections } : {}),
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved } : {}),
    })),
  };
}
interface CacheEntry {
  at: number;
}
/** Bounded in-memory metadata only. Store hashes, never instruction text or credentials. */
export class ContextCacheTracker {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 256,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1)
      throw new Error("Invalid cache metadata limit");
  }
  private key(request: CacheRequest, prefix = request.prefix): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          request.accountScope,
          request.connectionId,
          request.modelId,
          request.capabilities?.retentionMode,
          prefix,
        ]),
      )
      .digest("hex");
  }
  private matchingEntry(request: CacheRequest): CacheEntry | undefined {
    const direct = this.entries.get(this.key(request));
    if (direct) return direct;
    const prefix = request.prefix;
    if (
      !prefix ||
      typeof prefix !== "object" ||
      !("messages" in prefix) ||
      !Array.isArray(prefix.messages)
    )
      return;
    // Exact previously requested prefix may be followed by new exchanges. Hash only;
    // ignore transient Pi timestamps through providerContextPrefix at the caller.
    for (
      let count = prefix.messages.length - 1;
      count >= Math.max(0, prefix.messages.length - 256);
      count--
    ) {
      const candidate = { ...prefix, messages: prefix.messages.slice(0, count) };
      const entry = this.entries.get(this.key(request, candidate));
      if (entry) return entry;
    }
    return;
  }
  predict(request: CacheRequest): "likely-warm" | "likely-cold" | "unknown" {
    if (request.capabilities?.retentionMode === "none") return "likely-cold";
    const retention = request.capabilities?.retentionMs;
    if (!retention || retention <= 0 || !Number.isFinite(retention)) return "unknown";
    if (request.prefixTokens < (request.capabilities?.minimumTokens ?? 0)) return "likely-cold";
    const entry = this.matchingEntry(request);
    if (!entry) return "likely-cold";
    return this.now() - entry.at < retention ? "likely-warm" : "likely-cold";
  }
  stamp(request: CacheRequest): CacheRequest {
    return { ...request, startedAt: this.now() };
  }
  /** Record actual matching requests, including background calls. Cache reads confirm, zero disproves reuse. */
  record(request: CacheRequest, observedCacheReadTokens?: number | null) {
    const key = this.key(request);
    const startedAt = request.startedAt;
    const at = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : this.now();
    const previousAt = this.entries.get(key)?.at;
    this.entries.delete(key);
    this.entries.set(key, {
      at: previousAt === undefined ? at : Math.max(previousAt, at),
    });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
    return { observedReuse: observedCacheReadTokens == null ? null : observedCacheReadTokens > 0 };
  }
}

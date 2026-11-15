import { z } from "zod";
import { Id } from "./ids.js";

// Plain ISO dates denote UTC day boundaries; offsets retain their instant.
const HistoryDateBoundary = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error:
      "Use an ISO date (2026-01-01) or a datetime with Z or an offset (2026-01-01T08:00:00+08:00)",
  })
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO date boundary")
  .transform((value) => new Date(value).toISOString());

/** Leave room for both query attribution and a complete continuation inside a 10k result. */
export const HISTORY_QUERIES_MAX_BYTES = 3000;
const HISTORY_QUERIES_MAX = 5;

/** Keeps the first of query variants that differ only in case or surrounding space. */
function withoutRepeatedQueries<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (typeof value !== "string") return true;
    const key = value.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const HistoryQueriesSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(HISTORY_QUERIES_MAX)
  .transform(withoutRepeatedQueries)
  .refine(
    (values) =>
      new TextEncoder().encode(JSON.stringify(values)).byteLength <= HISTORY_QUERIES_MAX_BYTES,
    `History queries must fit within ${HISTORY_QUERIES_MAX_BYTES} UTF-8 bytes combined`,
  );

/**
 * Models often send both query and queries, or a bare string as queries, when they mean "search
 * for these words". Fold them into one queries list instead of failing the call.
 */
function foldQueryInputs(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { query, queries, ...rest } = input as Record<string, unknown>;
  const list = typeof queries === "string" ? [queries] : queries;
  if (list === undefined) return query === undefined ? rest : { ...rest, query };
  if (query === undefined || !Array.isArray(list)) return { ...rest, queries: list };
  // Drop repeats before capping, so a query repeating one of queries does not push out a term.
  return {
    ...rest,
    queries: withoutRepeatedQueries([query, ...list]).slice(0, HISTORY_QUERIES_MAX),
  };
}

/** The categories history search can filter by; the bot's tool schema reads the same list. */
export const HISTORY_SEARCH_KINDS = [
  "bot_messages",
  "user_messages",
  "bot_replies",
  "tool_work",
] as const;

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z.preprocess(
  foldQueryInputs,
  z
    .object({
      scope: z.enum(["this_chat", "my_chats"]).optional(),
      botId: Id.optional(),
      kinds: z
        .array(z.enum(HISTORY_SEARCH_KINDS))
        .min(1)
        .max(HISTORY_SEARCH_KINDS.length)
        .optional(),
      queries: HistoryQueriesSchema.optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      query: z.string().trim().min(1).max(500).optional(),
      before: HistoryDateBoundary.optional(),
      after: HistoryDateBoundary.optional(),
      beforeSeq: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .refine(
      (input) =>
        input.query !== undefined
          ? input.queries === undefined
          : input.queries !== undefined || input.kinds !== undefined,
      "Provide exactly one of query or queries, or neither with kinds",
    ),
);
/**
 * Files one history response lists. The run queues that many for its computer, so every listed
 * path is copied; the rest page through nextAttachmentOffset.
 */
export const HISTORY_ATTACHMENTS_PER_RESPONSE = 20;
export const HistoryReadInputSchema = z.object({
  messageId: Id,
  threadId: Id.optional(),
  linkedRunId: Id.optional(),
  runAfterId: Id.optional(),
  artifactAfterId: Id.optional(),
  outcomeAfterSeq: z.number().int().nonnegative().optional(),
  textOffset: z.number().int().nonnegative().optional(),
  /** Continues the anchor message's attachment list from a returned nextAttachmentOffset. */
  attachmentOffset: z.number().int().nonnegative().optional(),
  direction: z.enum(["around", "older", "newer"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type HistorySearchInput = z.infer<typeof HistorySearchInputSchema>;
export type HistoryReadInput = z.infer<typeof HistoryReadInputSchema>;

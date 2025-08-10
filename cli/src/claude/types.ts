/**
 * Simplified schema that only validates fields actually used in the codebase
 * while preserving all other fields through passthrough()
 */

import { z } from "zod";

// Usage statistics for assistant messages - used in apiSession.ts
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
}).passthrough();

// Main schema with minimal validation for only the fields we use
export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message - validates uuid and message.content
  z.object({
    type: z.literal("user"),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
    uuid: z.string(), // Used in getMessageKey()
    message: z.object({
      content: z.union([z.string(), z.any()]) // Used in sessionScanner.ts
    }).passthrough()
  }).passthrough(),

  // Assistant message - validates message object with usage and content
  z.object({
    uuid: z.string(),
    type: z.literal("assistant"),
    message: z.object({// Entire message used in getMessageKey()
      usage: UsageSchema.optional(), // Used in apiSession.ts
      content: z.any() // Used in tests
    }).passthrough()
  }).passthrough(),

  // Summary message - validates summary and leafUuid
  z.object({
    type: z.literal("summary"),
    summary: z.string(), // Used in apiSession.ts
    leafUuid: z.string() // Used in getMessageKey()
  }).passthrough(),

  // System message - validates uuid
  z.object({
    type: z.literal("system"),
    uuid: z.string() // Used in getMessageKey()
  }).passthrough()
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>

/**
 * Gemini Session JSONL Types
 *
 * Type definitions and Zod schemas for Gemini session persistence.
 * Each session is stored as a JSONL file where every line is one of these types.
 */

import { z } from 'zod';

export const GeminiSessionLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    message: z.string(),
    timestamp: z.number(),
    uuid: z.string(),
  }),

  z.object({
    type: z.literal('assistant'),
    message: z.string(),
    timestamp: z.number(),
    uuid: z.string(),
    model: z.string().optional(),
  }),

  z.object({
    type: z.literal('tool-call'),
    name: z.string(),
    callId: z.string(),
    input: z.unknown(),
    timestamp: z.number(),
    uuid: z.string(),
  }),

  z.object({
    type: z.literal('tool-result'),
    callId: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
    timestamp: z.number(),
    uuid: z.string(),
  }),

  z.object({
    type: z.literal('file-edit'),
    filePath: z.string(),
    description: z.string(),
    diff: z.string().optional(),
    timestamp: z.number(),
    uuid: z.string(),
  }),

  z.object({
    type: z.literal('meta'),
    key: z.string(),
    value: z.unknown(),
    timestamp: z.number(),
  }),
]);

export type GeminiSessionLine = z.infer<typeof GeminiSessionLineSchema>;

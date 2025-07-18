import { z } from "zod";

// Alright, bear with me here, because we are using constants, we have to define
// these types bottom up. Jump to the send to see the one schema to parse the
// entire claude code log file

// Usage statistics for assistant messages
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
});

// Text content block
const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

// Thinking content block
const ThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string(),
});

// Tool use content block
const ToolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(), // Tool-specific input parameters
});

// Tool result content block (in user messages)
const ToolResultContentSchema = z.object({
  tool_use_id: z.string(),
  type: z.literal("tool_result"),
  content: z.string(),
  is_error: z.boolean().optional(),
});

// Union of all content types
const ContentSchema = z.union([
  TextContentSchema,
  ThinkingContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
]);

// User message structure
const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(), // Simple string content
    z.array(ToolResultContentSchema), // Tool result content
  ]),
});

// Assistant message structure
const AssistantMessageSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(ContentSchema),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: UsageSchema,
});

// Base schema for all conversation entries
const BaseEntrySchema = z.object({
  //parentUuid: z.string().nullable(),
  //isSidechain: z.boolean(),
  //userType: z.string(),
  cwd: z.string(),
  sessionId: z.string(),
  version: z.string(),
  uuid: z.string(),
  timestamp: z.string().datetime(),
  parent_tool_use_id: z.string().nullable().optional(),
});

export const RawJSONLinesSchema = z.intersection(
  BaseEntrySchema,
  z.discriminatedUnion("type", [
    // User message entry
    z.object({
      type: z.literal("user"),
      message: UserMessageSchema,
      isMeta: z.boolean().optional(),
      toolUseResult: z.unknown().optional(), // Present when user responds to tool use
    }),

    // Assistant message entry
    z.object({
      type: z.literal("assistant"),
      message: AssistantMessageSchema,
      requestId: z.string(),
    }),
  ])
);

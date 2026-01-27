import * as z from 'zod';
import { MessageMetaSchema, MessageMeta } from '../typesMessageMeta';
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import { AGENT_IDS } from '@happy/agents';

//
// Raw types
//

// Usage data type from Claude API
const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    // Some upstream error payloads can include `service_tier: null`.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.string().nullish(),
});

export type UsageData = z.infer<typeof usageDataSchema>;

const agentEventSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('switch'),
    mode: z.enum(['local', 'remote'])
}), z.object({
    type: z.literal('message'),
    message: z.string(),
}), z.object({
    type: z.literal('limit-reached'),
    endsAt: z.number(),
}), z.object({
    type: z.literal('ready'),
})]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

const rawTextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawTextContent = z.infer<typeof rawTextContentSchema>;

const rawToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept unknown fields preserved by transform
export type RawToolUseContent = z.infer<typeof rawToolUseContentSchema>;

const rawToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    // Tool results can be strings, Claude-style arrays of text blocks, or structured JSON (Codex/Gemini).
    // We accept any here and normalize later for display.
    content: z.any(),
    is_error: z.boolean().optional(),
    permissions: z.object({
        date: z.number(),
        result: z.enum(['approved', 'denied']),
        mode: z.enum(PERMISSION_MODES).optional(),
        allowedTools: z.array(z.string()).optional(),
        decision: z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort']).optional(),
    }).optional(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawToolResultContent = z.infer<typeof rawToolResultContentSchema>;

/**
 * Extended thinking content from Claude API
 * Contains model's reasoning process before generating the final response
 * Uses .passthrough() to preserve signature and other unknown fields
 */
const rawThinkingContentSchema = z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
}).passthrough();  // ROBUST: Accept signature and future fields
export type RawThinkingContent = z.infer<typeof rawThinkingContentSchema>;

// ============================================================================
// WOLOG: Type-Safe Content Normalization via Zod Transform
// ============================================================================
// Accepts both hyphenated (Codex/Gemini) and underscore (Claude) formats
// Transforms all to canonical underscore format during validation
// Full type safety - no `unknown` types
// Source: Part D of the Expo Mobile Testing & Package Manager Agnostic System plan
// ============================================================================

/**
 * Hyphenated tool-call format from Codex/Gemini agents
 * Transforms to canonical tool_use format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolCallSchema = z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(), // Some messages have both
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolCall = z.infer<typeof rawHyphenatedToolCallSchema>;

/**
 * Hyphenated tool-call-result format from Codex/Gemini agents
 * Transforms to canonical tool_result format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolResultSchema = z.object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(), // Some messages have both
    output: z.any(),
    content: z.any().optional(), // Some messages have both
    is_error: z.boolean().optional(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolResult = z.infer<typeof rawHyphenatedToolResultSchema>;

/**
 * Input schema accepting ALL formats (both hyphenated and canonical)
 * Including Claude's extended thinking content type
 */
const rawAgentContentInputSchema = z.discriminatedUnion('type', [
    rawTextContentSchema,           // type: 'text' (canonical)
    rawToolUseContentSchema,        // type: 'tool_use' (canonical)
    rawToolResultContentSchema,     // type: 'tool_result' (canonical)
    rawThinkingContentSchema,       // type: 'thinking' (canonical)
    rawHyphenatedToolCallSchema,    // type: 'tool-call' (hyphenated)
    rawHyphenatedToolResultSchema,  // type: 'tool-call-result' (hyphenated)
]);
type RawAgentContentInput = z.infer<typeof rawAgentContentInputSchema>;

/**
 * Type-safe transform: Hyphenated tool-call → Canonical tool_use
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolUse(input: RawHyphenatedToolCall) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_use' as const,
        id: input.callId,  // Codex uses callId, canonical uses id
    };
}

/**
 * Type-safe transform: Hyphenated tool-call-result → Canonical tool_result
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolResult(input: RawHyphenatedToolResult) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_result' as const,
        tool_use_id: input.callId,  // Codex uses callId, canonical uses tool_use_id
        content: input.output ?? input.content ?? '',  // Codex uses output, canonical uses content
        is_error: input.is_error ?? false,
    };
}

/**
 * Schema that accepts both hyphenated and canonical formats.
 * Normalization happens via .preprocess() at root level to avoid Zod v4 "unmergable intersection" issue.
 * See: https://github.com/colinhacks/zod/discussions/2100
 *
 * Accepts: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'tool-call' | 'tool-call-result'
 * All types validated by their respective schemas with .passthrough() for unknown fields
 */
const rawAgentContentSchema = z.union([
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema,
    rawThinkingContentSchema,
    rawHyphenatedToolCallSchema,
    rawHyphenatedToolResultSchema,
]);
export type RawAgentContent = z.infer<typeof rawAgentContentSchema>;

const rawAgentRecordSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('output'),
    data: z.intersection(z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema), usage: usageDataSchema.optional() }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(rawAgentContentSchema)]) }), parent_tool_use_id: z.string().nullable().optional(), toolUseResult: z.any().nullable().optional() }),
    ]), z.object({
        isSidechain: z.boolean().nullish(),
        isCompactSummary: z.boolean().nullish(),
        isMeta: z.boolean().nullish(),
        uuid: z.string().nullish(),
        parentUuid: z.string().nullish(),
    }).passthrough()),  // ROBUST: Accept CLI metadata fields (userType, cwd, sessionId, version, gitBranch, slug, requestId, timestamp)
}), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        // Usage/metrics (Codex MCP sometimes sends token_count through the codex channel)
        z.object({ type: z.literal('token_count') }).passthrough(),
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        })
    ])
}), z.object({
    // ACP (Agent Communication Protocol) - unified format for all agent providers
    type: z.literal('acp'),
    provider: z.enum(AGENT_IDS),
    data: z.discriminatedUnion('type', [
        // Core message types
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        z.object({ type: z.literal('thinking'), text: z.string() }),
        // Tool interactions
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string(),
            isError: z.boolean().optional()
        }),
        // Hyphenated tool-call-result (for backwards compatibility with CLI)
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        }),
        // File operations
        z.object({
            type: z.literal('file-edit'),
            description: z.string(),
            filePath: z.string(),
            diff: z.string().optional(),
            oldContent: z.string().optional(),
            newContent: z.string().optional(),
            id: z.string()
        }).passthrough(),
        // Terminal/command output
        z.object({
            type: z.literal('terminal-output'),
            data: z.string(),
            callId: z.string()
        }).passthrough(),
        // Task lifecycle events
        z.object({ type: z.literal('task_started'), id: z.string() }),
        z.object({ type: z.literal('task_complete'), id: z.string() }),
        z.object({ type: z.literal('turn_aborted'), id: z.string() }),
        // Permissions
        z.object({
            type: z.literal('permission-request'),
            permissionId: z.string(),
            toolName: z.string(),
            description: z.string(),
            options: z.any().optional()
        }).passthrough(),
        // Usage/metrics
        z.object({ type: z.literal('token_count') }).passthrough()
    ])
})]);

/**
 * Preprocessor: Normalizes hyphenated content types to canonical before validation
 * This avoids Zod v4's "unmergable intersection" issue with transforms inside complex schemas
 * See: https://github.com/colinhacks/zod/discussions/2100
 */
function preprocessMessageContent(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // Helper: normalize a single content item
    const normalizeContent = (item: any): any => {
        if (!item || typeof item !== 'object') return item;

        if (item.type === 'tool-call') {
            return normalizeToToolUse(item);
        }
        if (item.type === 'tool-call-result') {
            return normalizeToToolResult(item);
        }
        return item;
    };

    // Normalize assistant message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.message?.content) {
        if (Array.isArray(data.content.data.message.content)) {
            data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
        }
    }

    // Normalize user message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.type === 'user' && Array.isArray(data.content.data.message?.content)) {
        data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
    }

    return data;
}

export const rawRecordSchema = z.preprocess(
    preprocessMessageContent,
    z.discriminatedUnion('role', [
        z.object({
            role: z.literal('agent'),
            content: rawAgentRecordSchema,
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('user'),
            content: z.object({
                type: z.literal('text'),
                text: z.string()
            }),
            meta: MessageMetaSchema.optional()
        })
    ])
);

export type RawRecord = z.infer<typeof rawRecordSchema>;

// Export schemas for validation
export const RawRecordSchema = rawRecordSchema;


//

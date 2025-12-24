import * as z from 'zod';
import { MessageMetaSchema, MessageMeta } from './typesMessageMeta';

//
// Raw types
//

// Usage data type from Claude API
const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    service_tier: z.string().optional(),
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
});
export type RawTextContent = z.infer<typeof rawTextContentSchema>;

const rawToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
});
export type RawToolUseContent = z.infer<typeof rawToolUseContentSchema>;

const rawToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.array(z.object({ type: z.literal('text'), text: z.string() })), z.string()]),
    is_error: z.boolean().optional(),
    permissions: z.object({
        date: z.number(),
        result: z.enum(['approved', 'denied']),
        mode: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
        decision: z.enum(['approved', 'approved_for_session', 'approved_execpolicy_amendment', 'denied', 'abort']).optional(),
    }).optional(),
});
export type RawToolResultContent = z.infer<typeof rawToolResultContentSchema>;

const rawAgentContentSchema = z.discriminatedUnion('type', [
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema
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
    })),
}), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
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
})]);

const rawRecordSchema = z.discriminatedUnion('role', [
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
]);

export type RawRecord = z.infer<typeof rawRecordSchema>;

// Export schemas for validation
export const RawRecordSchema = rawRecordSchema;


//
// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        content: any;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        };
    } | {
        type: 'summary',
        summary: string;
    } | {
        type: 'sidechain'
        uuid: string;
        prompt: string
    };

export type NormalizedMessage = ({
    role: 'user'
    content: {
        type: 'text';
        text: string;
    }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string,
    localId: string | null,
    createdAt: number,
    isSidechain: boolean,
    meta?: MessageMeta,
    usage?: UsageData,
};

export function normalizeRawMessage(id: string, localId: string | null, createdAt: number, raw: RawRecord): NormalizedMessage | null {
    let parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        console.error('Invalid raw record:');
        console.error(parsed.error.issues);
        console.error(raw);
        return null;
    }
    raw = parsed.data;
    if (raw.role === 'user') {
        return {
            id,
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
            meta: raw.meta,
        };
    }
    if (raw.role === 'agent') {
        if (raw.content.type === 'output') {

            // Skip Meta messages
            if (raw.content.data.isMeta) {
                return null;
            }

            // Skip compact summary messages
            if (raw.content.data.isCompactSummary) {
                return null;
            }

            // Handle Assistant messages (including sidechains)
            if (raw.content.data.type === 'assistant') {
                if (!raw.content.data.uuid) {
                    return null;
                }
                let content: NormalizedAgentContent[] = [];
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'text') {
                        content.push({ type: 'text', text: c.text, uuid: raw.content.data.uuid, parentUUID: raw.content.data.parentUuid ?? null });
                    } else if (c.type === 'tool_use') {
                        let description: string | null = null;
                        if (typeof c.input === 'object' && c.input !== null && 'description' in c.input && typeof c.input.description === 'string') {
                            description = c.input.description;
                        }
                        content.push({
                            type: 'tool-call',
                            id: c.id,
                            name: c.name,
                            input: c.input,
                            description, uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        });
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta,
                    usage: raw.content.data.message.usage
                };
            } else if (raw.content.data.type === 'user') {
                if (!raw.content.data.uuid) {
                    return null;
                }

                // Handle sidechain user messages
                if (raw.content.data.isSidechain && raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    // Return as a special agent message with sidechain content
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'agent',
                        isSidechain: true,
                        content: [{
                            type: 'sidechain',
                            uuid: raw.content.data.uuid,
                            prompt: raw.content.data.message.content
                        }]
                    };
                }

                // Handle regular user messages
                if (raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'user',
                        isSidechain: false,
                        content: {
                            type: 'text',
                            text: raw.content.data.message.content
                        }
                    };
                }

                // Handle tool results
                let content: NormalizedAgentContent[] = [];
                if (typeof raw.content.data.message.content === 'string') {
                    content.push({
                        type: 'text',
                        text: raw.content.data.message.content,
                        uuid: raw.content.data.uuid,
                        parentUUID: raw.content.data.parentUuid ?? null
                    });
                } else {
                    for (let c of raw.content.data.message.content) {
                        if (c.type === 'tool_result') {
                            content.push({
                                type: 'tool-result',
                                tool_use_id: c.tool_use_id,
                                content: raw.content.data.toolUseResult ? raw.content.data.toolUseResult : (typeof c.content === 'string' ? c.content : c.content[0].text),
                                is_error: c.is_error || false,
                                uuid: raw.content.data.uuid,
                                parentUUID: raw.content.data.parentUuid ?? null,
                                permissions: c.permissions ? {
                                    date: c.permissions.date,
                                    result: c.permissions.result,
                                    mode: c.permissions.mode,
                                    allowedTools: c.permissions.allowedTools,
                                    decision: c.permissions.decision
                                } : undefined
                            });
                        }
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta
                };
            }
        }
        if (raw.content.type === 'event') {
            return {
                id,
                localId,
                createdAt,
                role: 'event',
                content: raw.content.data,
                isSidechain: false,
            };
        }
        if (raw.content.type === 'codex') {
            if (raw.content.data.type === 'message') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                };
            }
            if (raw.content.data.type === 'reasoning') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                // Cast tool calls to agent tool-call messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call-result') {
                // Cast tool call results to agent tool-result messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
        }
    }
    return null;
}

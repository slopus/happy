import * as z from 'zod';

//
// Raw types
//

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
});
export type RawToolResultContent = z.infer<typeof rawToolResultContentSchema>;

const rawAgentContentSchema = z.discriminatedUnion('type', [
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema,
]);
export type RawAgentContent = z.infer<typeof rawAgentContentSchema>;

const rawAgentRecordSchema = z.object({
    type: z.literal('output'),
    data: z.intersection(z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema) }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.array(rawAgentContentSchema) }), parent_tool_use_id: z.string().nullable().optional(), toolUseResult: z.any().nullable().optional() }),
    ]), z.object({
        isSidechain: z.boolean().nullish(),
        isCompactSummary: z.boolean().nullish(),
        isMeta: z.boolean().nullish(),
        uuid: z.string().nullish(),
        parentUuid: z.string().nullish(),
    })),
});

const rawRecordSchema = z.discriminatedUnion('role', [
    z.object({
        role: z.literal('agent'),
        content: rawAgentRecordSchema
    }),
    z.object({
        role: z.literal('user'),
        content: z.object({ type: z.literal('text'), text: z.string() })
    }),
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
}) & {
    id: string,
    localId: string | null,
    createdAt: number,
    isSidechain: boolean,
};

export function normalizeRawMessage(id: string, localId: string | null, createdAt: number, raw: RawRecord): NormalizedMessage | null {
    if (raw.role === 'user') {
        return {
            id,
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
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
                    content
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
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'tool_result') {
                        content.push({
                            type: 'tool-result',
                            tool_use_id: c.tool_use_id,
                            content: raw.content.data.toolUseResult ? raw.content.data.toolUseResult : (typeof c.content === 'string' ? c.content : c.content[0].text),
                            is_error: c.is_error || false,
                            uuid: raw.content.data.uuid,
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
                    content
                };
            }
        }
    }
    return null;
}
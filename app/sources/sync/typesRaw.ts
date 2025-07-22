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
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema) }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.array(rawAgentContentSchema) }), parent_tool_use_id: z.string().nullable().optional() }),
    ]),
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
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        parent_id: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        content: string;
        is_error: boolean;
    } | {
        type: 'summary',
        summary: string;
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
};

export function normalizeRawMessage(id: string, localId: string | null, createdAt: number, raw: RawRecord): NormalizedMessage | null {
    if (raw.role === 'user') {
        return {
            id,
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
        };
    }
    if (raw.role === 'agent') {
        if (raw.content.type === 'output') {
            if (raw.content.data.type === 'summary') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    content: [{
                        type: 'summary',
                        summary: raw.content.data.summary,
                    }],
                };
            } else if (raw.content.data.type === 'assistant') {
                let content: NormalizedAgentContent[] = [];
                const parentToolId = raw.content.data.parent_tool_use_id || null;
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'text') {
                        content.push({ type: 'text', text: c.text });
                    } else if (c.type === 'tool_use') {
                        content.push({ type: 'tool-call', id: c.id, name: c.name, input: c.input, parent_id: parentToolId });
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    content
                };
            } else if (raw.content.data.type === 'user') {
                let content: NormalizedAgentContent[] = [];
                const parentToolId = raw.content.data.parent_tool_use_id || null;
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'tool_result') {
                        content.push({ type: 'tool-result', tool_use_id: c.tool_use_id, content: typeof c.content === 'string' ? c.content : c.content[0].text, is_error: c.is_error || false });
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    content
                };
            }
        }
    }
    return null;
}
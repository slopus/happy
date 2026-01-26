import type { MessageMeta } from '../typesMessageMeta';
import { rawRecordSchema, type AgentEvent, type RawRecord, type UsageData } from './schemas';

// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
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
    // Zod transform handles normalization during validation
    let parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        // Never log full raw messages in production: tool outputs and user text may contain secrets.
        // Keep enough context for debugging in dev builds only.
        console.error(`[typesRaw] Message validation failed (id=${id})`);
        if (__DEV__) {
            const contentType = (raw as any)?.content?.type;
            const dataType = (raw as any)?.content?.data?.type;
            const provider = (raw as any)?.content?.provider;
            const toolName =
                contentType === 'codex'
                    ? (raw as any)?.content?.data?.name
                    : contentType === 'acp'
                        ? (raw as any)?.content?.data?.name
                        : null;
            const callId =
                contentType === 'codex'
                    ? (raw as any)?.content?.data?.callId
                    : contentType === 'acp'
                        ? (raw as any)?.content?.data?.callId
                        : null;

            console.error('Zod issues:', JSON.stringify(parsed.error.issues, null, 2));
            console.error('Raw summary:', {
                role: raw?.role,
                contentType,
                dataType,
                provider,
                toolName: typeof toolName === 'string' ? toolName : undefined,
                callId: typeof callId === 'string' ? callId : undefined,
            });
        }
        return null;
    }
    raw = parsed.data;

    const toolResultContentToText = (content: unknown): string => {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') return content;

        // Claude sometimes sends tool_result.content as [{ type: 'text', text: '...' }]
        if (Array.isArray(content)) {
            const maybeTextBlocks = content as Array<{ type?: unknown; text?: unknown }>;
            const isTextBlocks = maybeTextBlocks.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
            if (isTextBlocks) {
                return maybeTextBlocks.map((b) => b.text as string).join('');
            }

            try {
                return JSON.stringify(content);
            } catch {
                return String(content);
            }
        }

        try {
            return JSON.stringify(content);
        } catch {
            return String(content);
        }
    };

    const maybeParseJsonString = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed) return value;
        const first = trimmed[0];
        if (first !== '{' && first !== '[') return value;
        try {
            return JSON.parse(trimmed) as unknown;
        } catch {
            return value;
        }
    };

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
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'thinking') {
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones (signature, etc.)
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'tool_use') {
                        let description: string | null = null;
                        if (typeof c.input === 'object' && c.input !== null && 'description' in c.input && typeof c.input.description === 'string') {
                            description = c.input.description;
                        }
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            type: 'tool-call',
                            description,
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
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
                            const rawResultContent = raw.content.data.toolUseResult ?? c.content;
                            content.push({
                                ...c,  // WOLOG: Preserve all fields including unknown ones
                                type: 'tool-result',
                                content: toolResultContentToText(rawResultContent),
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
                            } as NormalizedAgentContent);
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
                        content: toolResultContentToText(raw.content.data.output),
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
        }
        // ACP (Agent Communication Protocol) - unified format for all agent providers
        if (raw.content.type === 'acp') {
            if (raw.content.data.type === 'message') {
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
            if (raw.content.data.type === 'reasoning') {
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
                let description: string | null = null;
                const parsedInput = maybeParseJsonString(raw.content.data.input);
                const inputObj = (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput))
                    ? (parsedInput as Record<string, unknown>)
                    : null;
                const acpMeta = inputObj && inputObj._acp && typeof inputObj._acp === 'object' && !Array.isArray(inputObj._acp)
                    ? (inputObj._acp as Record<string, unknown>)
                    : null;
                const acpTitle = acpMeta && typeof acpMeta.title === 'string' ? acpMeta.title : null;
                const inputDescription = inputObj && typeof inputObj.description === 'string' ? inputObj.description : null;
                description = acpTitle ?? inputDescription ?? null;
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
                        input: parsedInput,
                        description,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-result') {
                const parsedOutput = maybeParseJsonString(raw.content.data.output);
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: parsedOutput,
                        is_error: raw.content.data.isError ?? false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Handle hyphenated tool-call-result (backwards compatibility)
            if (raw.content.data.type === 'tool-call-result') {
                const parsedOutput = maybeParseJsonString(raw.content.data.output);
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: parsedOutput,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'thinking') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'thinking',
                        thinking: raw.content.data.text,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'file-edit') {
                // Map file-edit to tool-call for UI rendering
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.id,
                        name: 'file-edit',
                        input: {
                            filePath: raw.content.data.filePath,
                            description: raw.content.data.description,
                            diff: raw.content.data.diff,
                            oldContent: raw.content.data.oldContent,
                            newContent: raw.content.data.newContent
                        },
                        description: raw.content.data.description,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'terminal-output') {
                // Map terminal-output to tool-result
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.data,
                        is_error: false,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'permission-request') {
                // Map permission-request to tool-call for UI to show permission dialog
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.permissionId,
                        name: raw.content.data.toolName,
                        input: raw.content.data.options ?? {},
                        description: raw.content.data.description,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Task lifecycle events (task_started, task_complete, turn_aborted) and token_count
            // are status/metrics - skip normalization, they don't need UI rendering
        }
    }
    return null;
}

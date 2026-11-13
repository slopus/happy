/** OpenAI-compatible tool calling transport, independent of installed agent CLIs. */
import { z } from 'zod';
import type { PersonalConfig } from './config';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string | null;
};
export type ToolDefinition = {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
};
const AssistantSchema = z.object({
    role: z.literal('assistant'), content: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({
        name: z.string().min(1), arguments: z.string(),
    }) })).max(32).optional(),
});
const ResponseSchema = z.object({ choices: z.array(z.object({
    message: AssistantSchema, finish_reason: z.string().nullable().optional(),
})).min(1) });

export async function completePersonalModel(config: PersonalConfig, messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): Promise<ChatMessage> {
    const endpoint = config.baseUrl.endsWith('/chat/completions') ? config.baseUrl : `${config.baseUrl}/chat/completions`;
    const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, messages, tools, stream: false }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    // Provider error bodies can contain authentication details. Keep them out of the chat and transcript.
    if (!response.ok) throw new Error(`Personal model API returned HTTP ${response.status}`);
    const choice = ResponseSchema.parse(await response.json()).choices[0];
    if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') throw new Error(`Personal model response stopped: ${choice.finish_reason}`);
    const message = choice.message;
    if (!message.content && !message.tool_calls?.length) throw new Error('Personal model returned an empty answer');
    if (message.tool_calls && new Set(message.tool_calls.map(call => call.id)).size !== message.tool_calls.length) {
        throw new Error('Personal model returned duplicate tool call IDs');
    }
    return { ...message, content: message.content ?? null };
}

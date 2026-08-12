import { RELATIONSHIP_ADVISOR_SYSTEM_PROMPT } from './_prompts';

interface AdvisorMessage {
    role: 'user' | 'assistant';
    text: string;
}

interface StreamRelationshipAdvisorInput {
    messages: AdvisorMessage[];
    imageUrls: string[];
    signal?: AbortSignal;
}

interface StreamRelationshipAdvisorOptions {
    apiKey: string;
    baseUrl: string;
    model: string;
    fetchImpl?: typeof fetch;
}

interface ProviderStreamDelta {
    choices?: Array<{
        delta?: { content?: string | null };
    }>;
}

type ProviderFetchSignal = NonNullable<Parameters<typeof fetch>[1]>['signal'];

function resolveChatCompletionsUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function providerMessages(messages: AdvisorMessage[], imageUrls: string[]) {
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'user') {
            lastUserIndex = index;
            break;
        }
    }
    return [
        { role: 'system', content: RELATIONSHIP_ADVISOR_SYSTEM_PROMPT },
        ...messages.map((message, index) => {
            if (index !== lastUserIndex || imageUrls.length === 0) {
                return { role: message.role, content: message.text };
            }
            return {
                role: 'user',
                content: [
                    { type: 'text', text: message.text.trim() || '请分析这些图片。' },
                    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
                ],
            };
        }),
    ];
}

function parseSseBlock(block: string): string | 'done' | null {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
    if (!data) return null;
    if (data === '[DONE]') return 'done';
    const parsed = JSON.parse(data) as ProviderStreamDelta;
    return parsed.choices?.[0]?.delta?.content ?? null;
}

export async function* streamRelationshipAdvisor(
    input: StreamRelationshipAdvisorInput,
    options: StreamRelationshipAdvisorOptions,
): AsyncGenerator<{ text: string }> {
    const response = await (options.fetchImpl ?? fetch)(resolveChatCompletionsUrl(options.baseUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
            model: options.model,
            messages: providerMessages(input.messages, input.imageUrls),
            stream: true,
            max_tokens: 1_200,
            temperature: 0.7,
        }),
        // elevenlabs brings in node-fetch's ambient AbortSignal declaration,
        // which disagrees structurally with Node's native signal at this boundary.
        signal: input.signal as ProviderFetchSignal,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Relationship advisor provider returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    if (!response.body) {
        throw new Error('Relationship advisor provider returned no stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
            const parsed = parseSseBlock(block);
            if (parsed === 'done') return;
            if (parsed) yield { text: parsed };
        }
    }

    buffer += decoder.decode();
    const parsed = parseSseBlock(buffer);
    if (parsed && parsed !== 'done') yield { text: parsed };
}

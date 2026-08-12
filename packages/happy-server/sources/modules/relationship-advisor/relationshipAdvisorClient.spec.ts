import { describe, expect, it, vi } from 'vitest';

import { streamRelationshipAdvisor } from './relationshipAdvisorClient';

function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    }), { status: 200 });
}

describe('streamRelationshipAdvisor', () => {
    it('sends multimodal OpenAI-compatible input and yields fragmented SSE deltas', async () => {
        const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => streamResponse([
            'data: {"choices":[{"delta":{"content":"先看"}}]}\n',
            '\ndata: {"choices":[{"delta":{"content":"事实"}}]}\n\n',
            'data: [DONE]\n\n',
        ]));

        const deltas: string[] = [];
        for await (const delta of streamRelationshipAdvisor({
            messages: [
                { role: 'assistant', text: '把截图发来吧。' },
                { role: 'user', text: '右侧蓝色气泡是我。' },
            ],
            imageUrls: ['https://oss.test/advisor/image.jpg?signature=short-lived'],
        }, {
            apiKey: 'server-only-key',
            baseUrl: 'https://model.test/v1',
            model: 'fast-vision-model',
            fetchImpl: fetchImpl as typeof fetch,
        })) {
            deltas.push(delta.text);
        }

        expect(deltas).toEqual(['先看', '事实']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://model.test/v1/chat/completions');
        expect(init?.headers).toEqual(expect.objectContaining({
            Authorization: 'Bearer server-only-key',
        }));
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual(expect.objectContaining({
            model: 'fast-vision-model',
            stream: true,
        }));
        expect(body.messages[0].role).toBe('system');
        expect(body.messages.at(-1)).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: '右侧蓝色气泡是我。' },
                { type: 'image_url', image_url: { url: 'https://oss.test/advisor/image.jpg?signature=short-lived' } },
            ],
        });
    });
});

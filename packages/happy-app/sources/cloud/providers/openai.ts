/**
 * OpenAI Cloud Provider
 *
 * Calls the OpenAI Chat Completions API with streaming (SSE).
 * Used for Codex cloud sessions, and any OpenAI-compatible API.
 *
 * API Reference: https://platform.openai.com/docs/api-reference/chat/create
 */

import type { CloudProvider, CloudProviderConfig, CloudMessage, CloudStreamEvent } from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';

export const OpenAICloudProvider: CloudProvider = {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: DEFAULT_MODEL,

    async sendMessage(
        messages: CloudMessage[],
        config: CloudProviderConfig,
        signal: AbortSignal,
        onEvent: (event: CloudStreamEvent) => void,
    ): Promise<void> {
        const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
        const model = config.model || DEFAULT_MODEL;

        const body = {
            model,
            stream: true,
            stream_options: { include_usage: true },
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        };

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            let errorMessage = `OpenAI API error: ${response.status}`;
            try {
                const parsed = JSON.parse(errorBody);
                if (parsed.error?.message) {
                    errorMessage = parsed.error.message;
                }
            } catch {
                if (errorBody) {
                    errorMessage += ` - ${errorBody.slice(0, 200)}`;
                }
            }
            onEvent({ type: 'error', error: errorMessage });
            return;
        }

        if (!response.body) {
            onEvent({ type: 'error', error: 'No response body from OpenAI API' });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Process complete lines
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete last line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6);
                    if (data === '[DONE]') {
                        onEvent({ type: 'text-done', text: fullText });
                        return;
                    }

                    try {
                        const parsed = JSON.parse(data);

                        // Handle content delta
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta?.content) {
                            fullText += delta.content;
                            onEvent({ type: 'text-delta', text: delta.content });
                        }

                        // Handle usage (sent with stream_options.include_usage)
                        if (parsed.usage) {
                            onEvent({
                                type: 'usage',
                                usage: {
                                    inputTokens: parsed.usage.prompt_tokens ?? 0,
                                    outputTokens: parsed.usage.completion_tokens ?? 0,
                                },
                            });
                        }
                    } catch {
                        // Skip malformed JSON chunks
                    }
                }
            }

            // If stream ended without [DONE], finalize
            if (fullText) {
                onEvent({ type: 'text-done', text: fullText });
            }
        } catch (error) {
            if (signal.aborted) return;
            const message = error instanceof Error ? error.message : 'Unknown streaming error';
            onEvent({ type: 'error', error: message });
        }
    },
};

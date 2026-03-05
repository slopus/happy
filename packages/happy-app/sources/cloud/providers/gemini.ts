/**
 * Gemini Cloud Provider
 *
 * Calls the Google AI Generative Language API with streaming.
 * Used for Gemini cloud sessions.
 *
 * API Reference: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
 */

import type { CloudProvider, CloudProviderConfig, CloudMessage, CloudStreamEvent } from '../types';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.0-flash';

export const GeminiCloudProvider: CloudProvider = {
    id: 'gemini',
    name: 'Google Gemini',
    defaultModel: DEFAULT_MODEL,

    async sendMessage(
        messages: CloudMessage[],
        config: CloudProviderConfig,
        signal: AbortSignal,
        onEvent: (event: CloudStreamEvent) => void,
    ): Promise<void> {
        const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
        const model = config.model || DEFAULT_MODEL;

        // Convert to Gemini format: contents with role 'user' | 'model'
        const contents = messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        const body = {
            contents,
            generationConfig: {
                maxOutputTokens: 8192,
            },
        };

        const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            let errorMessage = `Gemini API error: ${response.status}`;
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
            onEvent({ type: 'error', error: 'No response body from Gemini API' });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Gemini SSE: each line starts with "data: " followed by JSON
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6);

                    try {
                        const parsed = JSON.parse(data);

                        // Extract text from candidates
                        const candidates = parsed.candidates;
                        if (candidates?.[0]?.content?.parts) {
                            for (const part of candidates[0].content.parts) {
                                if (part.text) {
                                    fullText += part.text;
                                    onEvent({ type: 'text-delta', text: part.text });
                                }
                            }
                        }

                        // Extract usage metadata
                        if (parsed.usageMetadata) {
                            totalInputTokens = parsed.usageMetadata.promptTokenCount ?? totalInputTokens;
                            totalOutputTokens = parsed.usageMetadata.candidatesTokenCount ?? totalOutputTokens;
                        }
                    } catch {
                        // Skip malformed JSON chunks
                    }
                }
            }

            // Report final usage
            if (totalInputTokens > 0 || totalOutputTokens > 0) {
                onEvent({
                    type: 'usage',
                    usage: {
                        inputTokens: totalInputTokens,
                        outputTokens: totalOutputTokens,
                    },
                });
            }

            // Finalize
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

/**
 * Anthropic Cloud Provider
 *
 * Calls the Anthropic Messages API with streaming (SSE).
 * Used for Claude and OpenClaw cloud sessions.
 *
 * API Reference: https://docs.anthropic.com/en/api/messages-streaming
 */

import type { CloudProvider, CloudProviderConfig, CloudMessage, CloudStreamEvent } from '../types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_VERSION = '2023-06-01';

/**
 * Parse SSE lines from a text chunk.
 * Handles the `event:` and `data:` fields per the SSE spec.
 */
function* parseSSELines(text: string): Generator<{ event: string; data: string }> {
    const lines = text.split('\n');
    let currentEvent = '';
    let currentData = '';

    for (const line of lines) {
        if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
        } else if (line === '' && currentEvent) {
            yield { event: currentEvent, data: currentData };
            currentEvent = '';
            currentData = '';
        }
    }
}

export const AnthropicCloudProvider: CloudProvider = {
    id: 'anthropic',
    name: 'Anthropic',
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
            max_tokens: 8192,
            stream: true,
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        };

        const response = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': API_VERSION,
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify(body),
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            let errorMessage = `Anthropic API error: ${response.status}`;
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
            onEvent({ type: 'error', error: 'No response body from Anthropic API' });
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

                // Process complete SSE events from the buffer
                const lastNewline = buffer.lastIndexOf('\n\n');
                if (lastNewline === -1) continue;

                const complete = buffer.slice(0, lastNewline + 2);
                buffer = buffer.slice(lastNewline + 2);

                for (const { event, data } of parseSSELines(complete)) {
                    if (event === 'content_block_delta' && data) {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
                                fullText += parsed.delta.text;
                                onEvent({ type: 'text-delta', text: parsed.delta.text });
                            }
                        } catch {
                            // Skip malformed JSON
                        }
                    } else if (event === 'message_stop') {
                        onEvent({ type: 'text-done', text: fullText });
                    } else if (event === 'message_delta' && data) {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.usage) {
                                onEvent({
                                    type: 'usage',
                                    usage: {
                                        inputTokens: parsed.usage.input_tokens ?? 0,
                                        outputTokens: parsed.usage.output_tokens ?? 0,
                                    },
                                });
                            }
                        } catch {
                            // Skip malformed JSON
                        }
                    } else if (event === 'message_start' && data) {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.message?.usage) {
                                onEvent({
                                    type: 'usage',
                                    usage: {
                                        inputTokens: parsed.message.usage.input_tokens ?? 0,
                                        outputTokens: parsed.message.usage.output_tokens ?? 0,
                                    },
                                });
                            }
                        } catch {
                            // Skip malformed JSON
                        }
                    } else if (event === 'error' && data) {
                        try {
                            const parsed = JSON.parse(data);
                            onEvent({ type: 'error', error: parsed.error?.message || 'Unknown Anthropic error' });
                        } catch {
                            onEvent({ type: 'error', error: 'Unknown Anthropic streaming error' });
                        }
                    }
                }
            }

            // If we never got a message_stop, finalize with what we have
            if (fullText && !signal.aborted) {
                // message_stop may have been in the final buffer
                if (buffer.trim()) {
                    for (const { event } of parseSSELines(buffer + '\n\n')) {
                        if (event === 'message_stop') {
                            onEvent({ type: 'text-done', text: fullText });
                            return;
                        }
                    }
                }
            }
        } catch (error) {
            if (signal.aborted) return; // Normal cancellation
            const message = error instanceof Error ? error.message : 'Unknown streaming error';
            onEvent({ type: 'error', error: message });
        }
    },
};

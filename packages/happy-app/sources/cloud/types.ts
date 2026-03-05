/**
 * Cloud Chat Types
 *
 * Defines the common interfaces for client-side AI API calls.
 * Each provider (Anthropic, OpenAI, Gemini) implements CloudProvider
 * to normalize their streaming API into a common event format.
 */

/** A message in a cloud chat conversation */
export interface CloudMessage {
    role: 'user' | 'assistant';
    content: string;
}

/** Events emitted during a streaming API response */
export type CloudStreamEvent =
    | { type: 'text-delta'; text: string }
    | { type: 'text-done'; text: string }
    | { type: 'error'; error: string }
    | { type: 'usage'; usage: CloudUsage };

/** Token usage reported by the provider */
export interface CloudUsage {
    inputTokens: number;
    outputTokens: number;
}

/** Configuration for a cloud provider API call */
export interface CloudProviderConfig {
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

/** State of a cloud chat session */
export type CloudSessionState = 'idle' | 'sending' | 'streaming' | 'error';

/**
 * Cloud provider interface — each AI provider implements this.
 * The provider handles:
 *  - Building the API request from a conversation history
 *  - Streaming the response via SSE or other mechanism
 *  - Emitting normalized CloudStreamEvents
 */
export interface CloudProvider {
    /** Unique identifier for this provider (e.g., 'anthropic', 'openai', 'gemini') */
    id: string;

    /** Human-readable name */
    name: string;

    /** Default model to use if not specified in config */
    defaultModel: string;

    /**
     * Send a conversation to the AI API and stream the response.
     *
     * @param messages - Full conversation history
     * @param config - API key, base URL, model
     * @param signal - AbortSignal for cancellation
     * @param onEvent - Callback for streaming events
     */
    sendMessage(
        messages: CloudMessage[],
        config: CloudProviderConfig,
        signal: AbortSignal,
        onEvent: (event: CloudStreamEvent) => void,
    ): Promise<void>;
}

/** Metadata stored on a cloud session to identify it */
export interface CloudSessionMetadata {
    isCloud: true;
    cloudProvider: 'anthropic' | 'openai' | 'gemini';
    agentType: 'claude' | 'codex' | 'openclaw' | 'gemini';
    profileId?: string;
}

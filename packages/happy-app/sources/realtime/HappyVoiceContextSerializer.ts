export interface HappyVoiceContextPayload {
    version: 1;
    format: 'happy-app-context-v1';
    contentType: 'text/plain';
    text: string;
    createdAt: string;
}

/**
 * Provider-specific serializer for Happy Voice gateway context updates.
 * We intentionally send structured JSON instead of raw text.
 */
export function serializeHappyVoiceContext(update: string): HappyVoiceContextPayload {
    return {
        version: 1,
        format: 'happy-app-context-v1',
        contentType: 'text/plain',
        text: update,
        createdAt: new Date().toISOString(),
    };
}

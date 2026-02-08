export interface LiveKitContextPayload {
    version: 1;
    format: 'happy-app-context-v1';
    contentType: 'text/plain';
    text: string;
    createdAt: string;
}

/**
 * Provider-specific serializer for LiveKit gateway context updates.
 * We intentionally send structured JSON instead of raw text.
 */
export function serializeLiveKitContext(update: string): LiveKitContextPayload {
    return {
        version: 1,
        format: 'happy-app-context-v1',
        contentType: 'text/plain',
        text: update,
        createdAt: new Date().toISOString(),
    };
}

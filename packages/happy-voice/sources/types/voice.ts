export type VoiceSessionState = 'starting' | 'active' | 'stopped' | 'error';

export interface VoiceSessionRecord {
    gatewaySessionId: string;
    userId: string;
    appSessionId: string;
    roomName: string;
    participantIdentity: string;
    dispatchId?: string;
    state: VoiceSessionState;
    initialContextPayload?: HappyVoiceContextPayload;
    language?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    lastError?: string;
}

export interface VoiceStartRequest {
    userId: string;
    sessionId: string;
    initialContextPayload?: HappyVoiceContextPayload;
    language?: string;
    toolBridgeBaseUrl?: string;
    welcomeMessage?: string;
}

export interface VoiceStartResponse {
    allowed: boolean;
    gatewaySessionId: string;
    roomName: string;
    roomUrl: string;
    participantIdentity: string;
    participantToken: string;
    expiresAt: string;
}

export interface HappyVoiceContextPayload {
    version: 1;
    format: 'happy-app-context-v1';
    contentType: 'text/plain';
    text: string;
    createdAt: string;
}

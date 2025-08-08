export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected';
export type ConversationMode = 'speaking' | 'listening';
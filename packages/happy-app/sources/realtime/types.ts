export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    pushToTalk?: boolean;
    // OpenAI backend
    apiKey?: string;
    // ElevenLabs backend
    token?: string;
    agentId?: string;
    userId?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
    startTalking(): void;
    stopTalking(): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected';
export type ConversationMode = 'idle' | 'agent-speaking' | 'user-speaking';
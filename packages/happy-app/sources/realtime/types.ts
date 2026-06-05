export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    systemPrompt?: string;
    firstMessage?: string;
    conversationToken?: string;
    agentId?: string;
    userId?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<string | null>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected';
export type ConversationMode = 'idle' | 'agent-speaking' | 'user-speaking';

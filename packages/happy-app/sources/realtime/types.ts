// Voice mode selection
export type VoiceMode = 'assistant' | 'dictation';

// Whisper recording status (used by dictation mode)
export type RecordingStatus = 'idle' | 'recording' | 'transcribing';

// Whisper recorder interface (used by dictation mode)
export interface WhisperRecorder {
    start: () => Promise<void>;
    stop: () => Promise<string>; // Returns audio file URI
}

// ElevenLabs types (used by assistant mode)
export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    token?: string;
    agentId?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<void>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected';
export type ConversationMode = 'speaking' | 'listening';

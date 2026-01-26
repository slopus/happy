/**
 * Voice Provider Types
 * Abstract interfaces for voice provider implementations
 */

// ===== Provider Configuration =====

/**
 * Supported voice provider types
 */
export type VoiceProviderType = 'elevenlabs' | 'stepfun' | 'none';

/**
 * Base configuration for all voice sessions
 * Includes optional provider-specific fields for backward compatibility
 */
export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    // ElevenLabs fields (for backward compatibility)
    token?: string;
    agentId?: string;
    // StepFun fields
    apiKey?: string;
    modelId?: string;
    voice?: string;
    // Provider identifier
    provider?: VoiceProviderType;
}

/**
 * ElevenLabs specific configuration
 */
export interface ElevenLabsConfig extends VoiceSessionConfig {
    provider: 'elevenlabs';
    token?: string;
    agentId?: string;
}

/**
 * StepFun specific configuration
 */
export interface StepFunConfig extends VoiceSessionConfig {
    provider: 'stepfun';
    apiKey: string;
    modelId?: string;
    voice?: string;
}

/**
 * Union type for all provider configs
 */
export type ProviderConfig = ElevenLabsConfig | StepFunConfig;

// ===== Voice Session Interface =====

/**
 * Abstract interface for voice session implementations
 * Each provider must implement this interface
 */
export interface VoiceSession {
    /**
     * Start a voice session with the given configuration
     */
    startSession(config: VoiceSessionConfig): Promise<void>;

    /**
     * End the current voice session
     */
    endSession(): Promise<void>;

    /**
     * Send a text message to the voice assistant
     * The assistant will respond to this message
     */
    sendTextMessage(message: string): void;

    /**
     * Send a contextual update to the voice assistant
     * This is a silent update that provides context without triggering a response
     */
    sendContextualUpdate(update: string): void;
}

// ===== Voice Provider Interface =====

/**
 * Voice provider adapter interface
 * Each platform (ElevenLabs, StepFun, etc.) implements this interface
 */
export interface VoiceProviderAdapter {
    /**
     * Provider type identifier
     */
    readonly type: VoiceProviderType;

    /**
     * Initialize the provider (called once at app startup)
     */
    initialize(): Promise<void>;

    /**
     * Create a voice session instance
     */
    createSession(): VoiceSession;

    /**
     * Clean up provider resources
     */
    dispose(): void;
}

// ===== Status Types =====

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ConversationMode = 'speaking' | 'idle';

// ===== Tool Definition Interface =====

/**
 * Generic tool definition for voice assistants
 * Can be converted to platform-specific formats
 */
export interface VoiceTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description?: string;
            enum?: string[];
        }>;
        required?: string[];
    };
    execute: (args: unknown) => Promise<string>;
}

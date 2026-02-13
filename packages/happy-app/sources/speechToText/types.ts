/**
 * Speech-to-Text Module Types
 *
 * Core type definitions for the STT feature using local Whisper models.
 */

// =============================================================================
// Provider Types
// =============================================================================

/**
 * Available STT provider (local Whisper only)
 */
export type STTProviderType = 'whisper-local';

/**
 * Whisper model sizes available for local inference
 */
export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium';

/**
 * Model information
 */
export interface WhisperModelInfo {
    size: WhisperModelSize;
    displayName: string;
    fileSize: number;        // bytes
    downloadUrl: string;
    coreMLUrl?: string;      // iOS Core ML model URL
    languages: string[];     // Supported language codes
}

// =============================================================================
// Session State
// =============================================================================

/**
 * STT session status
 */
export type STTSessionStatus =
    | 'idle'           // Not active
    | 'initializing'   // Loading model / connecting
    | 'recording'      // Actively recording and transcribing
    | 'processing'     // Final processing (for batch providers)
    | 'error';         // Error state

/**
 * STT session state
 */
export interface STTSessionState {
    status: STTSessionStatus;
    error?: STTError;
}

// =============================================================================
// Transcript
// =============================================================================

/**
 * A segment of transcribed speech
 */
export interface TranscriptSegment {
    id: string;
    text: string;
    start: number;       // Start time in ms
    end: number;         // End time in ms
    confidence?: number; // 0-1
}

/**
 * Transcript result from the provider
 */
export interface TranscriptResult {
    /** Current recognized text */
    text: string;
    /** Whether this is a final (committed) result */
    isFinal: boolean;
    /** Recognition confidence (0-1) */
    confidence?: number;
    /** Individual segments with timing info */
    segments?: TranscriptSegment[];
    /** Detected language code */
    detectedLanguage?: string;
}

/**
 * Full transcript state for UI display
 */
export interface TranscriptState {
    /** Accumulated final text */
    finalText: string;
    /** Current partial/interim text */
    partialText: string;
    /** Combined text for display (finalText + partialText) */
    displayText: string;
    /** All segments */
    segments: TranscriptSegment[];
}

// =============================================================================
// Audio
// =============================================================================

/**
 * Audio level data for visualization
 */
export interface AudioLevelData {
    /** Normalized audio level (0-1) */
    level: number;
    /** Timestamp in ms */
    timestamp: number;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * STT error codes
 */
export type STTErrorCode =
    | 'permission_denied'      // Microphone permission not granted
    | 'model_not_ready'        // Local model not downloaded/loaded
    | 'model_load_failed'      // Failed to load local model
    | 'network_error'          // Network connectivity issue
    | 'provider_error'         // Provider-specific error
    | 'audio_error'            // Audio capture error
    | 'timeout'                // Operation timed out
    | 'cancelled'              // User cancelled
    | 'unknown';               // Unknown error

/**
 * STT error
 */
export interface STTError {
    code: STTErrorCode;
    message: string;
    /** Whether the operation can be retried */
    recoverable: boolean;
    /** Underlying error if any */
    cause?: Error;
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Callbacks for STT session events
 */
export interface STTSessionCallbacks {
    /** Called when transcript is updated (partial or final) */
    onTranscript: (result: TranscriptResult) => void;
    /** Called with audio level updates for visualization */
    onAudioLevel?: (data: AudioLevelData) => void;
    /** Called when session state changes */
    onStateChange?: (state: STTSessionState) => void;
    /** Called on error */
    onError?: (error: STTError) => void;
}

/**
 * Provider configuration
 */
export interface STTProviderConfig {
    /** Target language code (e.g., 'zh-CN', 'en-US'), null for auto-detect */
    language?: string | null;
    /** API key for cloud providers */
    apiKey?: string;
    /** Provider-specific options */
    options?: Record<string, unknown>;
}

/**
 * Abstract interface for STT providers
 */
export interface ISTTProvider {
    /** Provider type identifier */
    readonly type: STTProviderType;
    /** Whether this provider supports real-time streaming */
    readonly isStreaming: boolean;
    /** Supported language codes */
    readonly supportedLanguages: string[];

    /**
     * Initialize the provider
     */
    initialize(config: STTProviderConfig): Promise<void>;

    /**
     * Release resources
     */
    dispose(): Promise<void>;

    /**
     * Start a transcription session
     */
    startSession(callbacks: STTSessionCallbacks): Promise<void>;

    /**
     * Stop the session and return final transcript
     */
    stopSession(): Promise<string>;

    /**
     * Cancel the session without returning results
     */
    cancelSession(): void;

    /**
     * Get current session state
     */
    getState(): STTSessionState;

    /**
     * Check if provider is ready to use
     */
    isReady(): boolean;
}

// =============================================================================
// Settings
// =============================================================================

/**
 * STT settings stored in app preferences (local Whisper only)
 */
export interface STTSettings {
    /** Whether STT is enabled */
    enabled: boolean;

    /** Selected local model size */
    localModel: WhisperModelSize;

    /** Target language (null = auto-detect) */
    language: string | null;

    /** Show waveform visualization */
    showWaveform: boolean;

    /** Enable haptic feedback */
    hapticFeedback: boolean;
}

/**
 * Default STT settings
 */
export const DEFAULT_STT_SETTINGS: STTSettings = {
    enabled: true,
    localModel: 'small',
    language: null,
    showWaveform: true,
    hapticFeedback: true,
};

// =============================================================================
// Model Download
// =============================================================================

/**
 * Model download status
 */
export type ModelDownloadStatus =
    | 'not_downloaded'
    | 'downloading'
    | 'downloaded'
    | 'error';

/**
 * Model download progress
 */
export interface ModelDownloadProgress {
    status: ModelDownloadStatus;
    /** Download progress (0-1) */
    progress: number;
    /** Bytes downloaded */
    bytesDownloaded: number;
    /** Total bytes */
    totalBytes: number;
    /** Error message if status is 'error' */
    error?: string;
}

/**
 * Model state for a specific model size
 */
export interface ModelState {
    size: WhisperModelSize;
    status: ModelDownloadStatus;
    /** Local file path if downloaded */
    filePath?: string;
    /** Core ML model path if available (iOS) */
    coreMLPath?: string;
    /** Last download progress */
    progress?: ModelDownloadProgress;
}

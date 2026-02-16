/**
 * ASR (Automatic Speech Recognition) Module Types
 *
 * This module provides a provider-agnostic interface for speech-to-text functionality.
 * Currently supports StepFun ASR with a design that allows easy addition of other providers.
 */

/**
 * Supported ASR provider types
 */
export type ASRProviderType = 'stepfun' | 'none';

/**
 * Options for ASR transcription
 */
export interface ASROptions {
    /** Audio format (default: wav) */
    format?: 'wav' | 'webm' | 'mp3' | 'flac' | 'ogg';
    /** Hot words for better recognition accuracy */
    hotwords?: string[];
    /** Response format */
    responseFormat?: 'json' | 'text' | 'srt' | 'vtt';
}

/**
 * Result from ASR transcription
 */
export interface ASRResult {
    /** Transcribed text */
    text: string;
    /** Confidence score (0-1, if available) */
    confidence?: number;
    /** Duration of the audio in milliseconds */
    durationMs?: number;
}

/**
 * Audio data for ASR - supports both Blob (web) and base64 (native)
 */
export type AudioData =
    | Blob
    | {
        /** Base64 encoded audio data */
        base64: string;
        /** MIME type of the audio */
        mimeType: string;
        /** File name for the upload */
        fileName: string;
    };

/**
 * ASR Provider interface
 * All ASR providers must implement this interface
 */
export interface ASRProvider {
    /** Provider name for identification */
    readonly name: ASRProviderType;

    /**
     * Transcribe audio to text
     * @param audio - Audio data as Blob or base64 object
     * @param options - Optional transcription options
     * @returns Promise resolving to transcription result
     */
    transcribe(audio: AudioData, options?: ASROptions): Promise<ASRResult>;

    /**
     * Check if the provider is properly configured
     * @returns true if the provider can be used
     */
    isConfigured(): boolean;
}

/**
 * Configuration for ASR service
 */
export interface ASRConfig {
    /** Selected provider */
    provider: ASRProviderType;
    /** StepFun specific configuration */
    stepfun?: {
        apiKey?: string;
    };
}

/**
 * Voice input state for the useVoiceInput hook
 */
export interface VoiceInputState {
    /** Whether currently recording */
    isRecording: boolean;
    /** Whether ASR is processing */
    isTranscribing: boolean;
    /** Current transcribed text (accumulated) */
    transcribedText: string;
    /** Current gesture zone based on finger position */
    gestureZone: 'send' | 'cancel' | 'text';
    /** Recording duration in milliseconds */
    recordingDuration: number;
    /** Current audio level (0-1), used for waveform animation */
    audioLevel: number;
    /** Error message if any */
    error: string | null;
}

/**
 * Gesture zone thresholds for voice input overlay
 */
export interface GestureThresholds {
    /** Y offset to trigger zone change (negative = up) */
    yThreshold: number;
    /** X offset required to enter cancel/text zone (dx <= -xThreshold => cancel, dx >= xThreshold => text) */
    xThreshold: number;
}

/**
 * Default gesture thresholds
 */
export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
    yThreshold: -90,   // 90px up to enter cancel/text zone
    xThreshold: 40,    // require left swipe to cancel, right swipe to enter text zone
};

/**
 * Voice input recording parameters
 */
export interface VoiceInputParams {
    /** Delay before first ASR upload (ms) */
    initialUploadDelay: number;
    /** Interval between subsequent uploads (ms) */
    uploadInterval: number;
    /** Maximum recording duration (ms) */
    maxDuration: number;
}

/**
 * Default voice input parameters
 */
export const DEFAULT_VOICE_INPUT_PARAMS: VoiceInputParams = {
    initialUploadDelay: 3000,  // 3s before first upload
    uploadInterval: 3000,      // 3s between uploads
    maxDuration: 60000,        // 60s max recording
};

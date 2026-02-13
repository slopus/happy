/**
 * Speech-to-Text Module
 *
 * Provides voice input to text functionality with support for:
 * - Local Whisper models (offline, private)
 * - Cloud ASR services (Deepgram, etc.)
 * - Real-time streaming transcription
 * - Feishu-style UI overlay
 *
 * @example
 * ```tsx
 * import { useSTT, STTOverlay } from '@/speechToText';
 *
 * function MyComponent() {
 *   const {
 *     isRecording,
 *     displayText,
 *     audioLevel,
 *     startRecording,
 *     stopRecording,
 *     cancelRecording,
 *   } = useSTT({
 *     onComplete: (text) => console.log('Transcribed:', text),
 *   });
 *
 *   return (
 *     <>
 *       <Button onPress={startRecording} title="Start Recording" />
 *       <STTOverlay
 *         visible={isRecording}
 *         transcript={displayText}
 *         audioLevel={audioLevel}
 *         onCancel={cancelRecording}
 *         onConfirm={stopRecording}
 *       />
 *     </>
 *   );
 * }
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
    // Core types
    STTProviderType,
    WhisperModelSize,
    STTSessionStatus,
    STTSessionState,
    STTError,
    STTErrorCode,
    STTSettings,

    // Transcript types
    TranscriptResult,
    TranscriptSegment,
    TranscriptState,

    // Audio types
    AudioLevelData,

    // Provider types
    ISTTProvider,
    STTProviderConfig,
    STTSessionCallbacks,

    // Model types
    WhisperModelInfo,
    ModelState,
    ModelDownloadStatus,
    ModelDownloadProgress,
} from './types';

export { DEFAULT_STT_SETTINGS } from './types';

// =============================================================================
// Hooks
// =============================================================================

export { useSTT } from './hooks/useSTT';
export type { UseSTTOptions, UseSTTReturn } from './hooks/useSTT';

export { useWhisperModel } from './hooks/useWhisperModel';
export type { UseWhisperModelReturn } from './hooks/useWhisperModel';

export { useSTTIntegration } from './hooks/useSTTIntegration';
export type { UseSTTIntegrationOptions, UseSTTIntegrationReturn } from './hooks/useSTTIntegration';

// =============================================================================
// Components
// =============================================================================

export { STTOverlay } from './components/STTOverlay';
export type { STTOverlayProps } from './components/STTOverlay';

export { STTWaveform } from './components/STTWaveform';
export type { STTWaveformProps } from './components/STTWaveform';

export { STTTranscriptView } from './components/STTTranscriptView';
export type { STTTranscriptViewProps } from './components/STTTranscriptView';

// =============================================================================
// Utilities
// =============================================================================

export { getModelDownloader } from './utils/modelDownloader';
export type { ModelDownloadCallbacks } from './utils/modelDownloader';

export { getAudioCapture } from './utils/audioCapture';
export type { AudioCaptureCallbacks } from './utils/audioCapture';

// =============================================================================
// Configuration
// =============================================================================

export { WHISPER_MODELS, toWhisperLanguageCode, AUDIO_CONFIG, STT_LIMITS } from './config';

// =============================================================================
// Providers (for advanced use)
// =============================================================================

export { BaseSTTProvider } from './providers/BaseSTTProvider';
export { WhisperLocalProvider } from './providers/WhisperLocalProvider';

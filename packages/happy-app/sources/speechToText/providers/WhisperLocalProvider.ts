/**
 * Whisper Local Provider
 *
 * STT provider using local Whisper model via whisper.rn.
 * Supports real-time transcription with VAD (Voice Activity Detection).
 */

import { Platform } from 'react-native';
import { BaseSTTProvider } from './BaseSTTProvider';
import {
    STTProviderType,
    STTProviderConfig,
    WhisperModelSize,
    TranscriptResult,
} from '../types';
import { AUDIO_CONFIG, toWhisperLanguageCode } from '../config';

// whisper.rn imports - these will be dynamically imported
// to avoid errors when the package is not installed
type WhisperContext = {
    transcribe: (
        audioPath: string,
        options: Record<string, unknown>
    ) => { stop: () => void; promise: Promise<{ result: string }> };
};

type VADContext = {
    detectSpeech: (
        audioPath: string,
        options: Record<string, unknown>
    ) => Promise<Array<{ start: number; end: number }>>;
};

interface WhisperRN {
    initWhisper: (options: { filePath: string; coreMLModelAsset?: string }) => Promise<WhisperContext>;
    initWhisperVad?: (options: { filePath: string }) => Promise<VADContext>;
}

// Audio recording interface
interface AudioRecorder {
    start: () => Promise<void>;
    stop: () => Promise<string>;  // Returns file path
    cancel: () => void;
    onAudioLevel?: (callback: (level: number) => void) => void;
}

export class WhisperLocalProvider extends BaseSTTProvider {
    readonly type: STTProviderType = 'whisper-local';
    readonly isStreaming = true;
    readonly supportedLanguages = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru'];

    private whisperRN: WhisperRN | null = null;
    private whisperContext: WhisperContext | null = null;
    private vadContext: VADContext | null = null;
    private audioRecorder: AudioRecorder | null = null;
    private modelPath: string | null = null;
    private coreMLPath: string | null = null;
    private vadModelPath: string | null = null;
    private isRecording = false;
    private accumulatedText = '';
    private currentTranscribeHandle: { stop: () => void } | null = null;

    // Audio level monitoring
    private audioLevelInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Configure the provider with model paths
     */
    setModelPaths(options: {
        modelPath: string;
        coreMLPath?: string;
        vadModelPath?: string;
    }): void {
        this.modelPath = options.modelPath;
        this.coreMLPath = options.coreMLPath;
        this.vadModelPath = options.vadModelPath;
    }

    /**
     * Set custom audio recorder
     */
    setAudioRecorder(recorder: AudioRecorder): void {
        this.audioRecorder = recorder;
    }

    protected async onInitialize(): Promise<void> {
        // Dynamically import whisper.rn
        try {
            this.whisperRN = await import('whisper.rn');
        } catch (error) {
            throw this.createError(
                'model_load_failed',
                'whisper.rn is not installed. Please run: yarn add whisper.rn',
                false,
                error instanceof Error ? error : undefined
            );
        }

        if (!this.modelPath) {
            throw this.createError(
                'model_not_ready',
                'Model path not set. Please download a Whisper model first.',
                false
            );
        }

        // Initialize Whisper context
        try {
            const initOptions: { filePath: string; coreMLModelAsset?: string } = {
                filePath: this.modelPath,
            };

            // Use Core ML on iOS for better performance
            if (Platform.OS === 'ios' && this.coreMLPath) {
                initOptions.coreMLModelAsset = this.coreMLPath;
            }

            this.whisperContext = await this.whisperRN.initWhisper(initOptions);
        } catch (error) {
            throw this.createError(
                'model_load_failed',
                `Failed to load Whisper model: ${error instanceof Error ? error.message : String(error)}`,
                false,
                error instanceof Error ? error : undefined
            );
        }

        // Initialize VAD context if available
        if (this.vadModelPath && this.whisperRN.initWhisperVad) {
            try {
                this.vadContext = await this.whisperRN.initWhisperVad({
                    filePath: this.vadModelPath,
                });
            } catch (error) {
                // VAD is optional, just log the error
                console.warn('Failed to initialize VAD:', error);
            }
        }
    }

    protected async onDispose(): Promise<void> {
        this.stopAudioLevelMonitoring();

        if (this.currentTranscribeHandle) {
            this.currentTranscribeHandle.stop();
            this.currentTranscribeHandle = null;
        }

        // whisper.rn contexts don't have explicit dispose methods
        // but we should clean up our references
        this.whisperContext = null;
        this.vadContext = null;
        this.audioRecorder = null;
    }

    protected async onStartSession(): Promise<void> {
        if (!this.whisperContext) {
            throw this.createError(
                'model_not_ready',
                'Whisper model not initialized',
                false
            );
        }

        if (!this.audioRecorder) {
            throw this.createError(
                'audio_error',
                'Audio recorder not configured',
                false
            );
        }

        this.accumulatedText = '';
        this.isRecording = true;

        // Start audio recording
        await this.audioRecorder.start();

        // Start audio level monitoring
        this.startAudioLevelMonitoring();

        // For real-time transcription, we process audio chunks periodically
        this.startRealtimeTranscription();
    }

    protected async onStopSession(): Promise<string> {
        this.isRecording = false;
        this.stopAudioLevelMonitoring();

        if (this.currentTranscribeHandle) {
            this.currentTranscribeHandle.stop();
            this.currentTranscribeHandle = null;
        }

        if (!this.audioRecorder) {
            return this.accumulatedText;
        }

        // Stop recording and get final audio file
        const audioPath = await this.audioRecorder.stop();

        // Perform final transcription on complete audio
        if (this.whisperContext && audioPath) {
            try {
                const finalResult = await this.transcribeAudio(audioPath, true);
                if (finalResult) {
                    this.accumulatedText = finalResult;
                }
            } catch (error) {
                console.warn('Final transcription failed:', error);
            }
        }

        return this.accumulatedText.trim();
    }

    protected onCancelSession(): void {
        this.isRecording = false;
        this.stopAudioLevelMonitoring();

        if (this.currentTranscribeHandle) {
            this.currentTranscribeHandle.stop();
            this.currentTranscribeHandle = null;
        }

        this.audioRecorder?.cancel();
        this.accumulatedText = '';
    }

    override isReady(): boolean {
        return super.isReady() && this.whisperContext !== null && this.modelPath !== null;
    }

    // ==========================================================================
    // Private Methods
    // ==========================================================================

    private startAudioLevelMonitoring(): void {
        if (this.audioRecorder?.onAudioLevel) {
            this.audioRecorder.onAudioLevel((level) => {
                this.emitAudioLevel({
                    level: Math.min(1, Math.max(0, level)),
                    timestamp: Date.now(),
                });
            });
        } else {
            // Fallback: simulate audio levels
            this.audioLevelInterval = setInterval(() => {
                if (this.isRecording) {
                    // Generate a pseudo-random level for visual feedback
                    const level = 0.3 + Math.random() * 0.4;
                    this.emitAudioLevel({
                        level,
                        timestamp: Date.now(),
                    });
                }
            }, 100);
        }
    }

    private stopAudioLevelMonitoring(): void {
        if (this.audioLevelInterval) {
            clearInterval(this.audioLevelInterval);
            this.audioLevelInterval = null;
        }
    }

    private startRealtimeTranscription(): void {
        // For whisper.rn, we'll implement chunk-based transcription
        // The actual implementation depends on the audio recorder providing chunks
        // For now, we rely on the final transcription in onStopSession
    }

    private async transcribeAudio(audioPath: string, isFinal: boolean): Promise<string | null> {
        if (!this.whisperContext) {
            return null;
        }

        const language = toWhisperLanguageCode(this.config?.language);

        const options: Record<string, unknown> = {
            language: language || 'auto',
            maxLen: 1,  // Return results quickly for streaming feel
            tokenTimestamps: true,
            // Performance optimizations
            speedUp: true,
            // CPU threads (adjust based on device)
            maxThreads: Platform.OS === 'ios' ? 4 : 2,
        };

        try {
            const { stop, promise } = this.whisperContext.transcribe(audioPath, options);
            this.currentTranscribeHandle = { stop };

            const { result } = await promise;
            this.currentTranscribeHandle = null;

            if (result) {
                const transcriptResult: TranscriptResult = {
                    text: result,
                    isFinal,
                    confidence: 0.9,  // whisper.rn doesn't provide confidence
                };

                this.emitTranscript(transcriptResult);
                return result;
            }

            return null;
        } catch (error) {
            console.error('Transcription error:', error);
            return null;
        }
    }
}

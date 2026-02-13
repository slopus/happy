/**
 * useSTT Hook
 *
 * Main hook for using Speech-to-Text functionality in components.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import {
    STTSettings,
    STTError,
    TranscriptResult,
    TranscriptState,
    STTSessionState,
    ISTTProvider,
    WhisperModelSize,
    DEFAULT_STT_SETTINGS,
} from '../types';
import { WhisperLocalProvider } from '../providers/WhisperLocalProvider';
import { getModelDownloader, ModelDownloader } from '../utils/modelDownloader';
import { AudioCapture, getAudioCapture } from '../utils/audioCapture';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { useSetting } from '@/sync/storage';

// =============================================================================
// Types
// =============================================================================

export interface UseSTTOptions {
    /** Target language code (null = auto-detect) */
    language?: string | null;
    /** Callback when final transcript is ready */
    onTranscript?: (text: string) => void;
    /** Callback for partial/interim transcripts */
    onPartialTranscript?: (text: string) => void;
    /** Callback when recording completes */
    onComplete?: (finalText: string) => void;
    /** Callback when recording is cancelled */
    onCancel?: () => void;
    /** Callback on error */
    onError?: (error: STTError) => void;
}

export interface UseSTTReturn {
    // State
    /** Whether currently recording */
    isRecording: boolean;
    /** Whether processing final transcription */
    isProcessing: boolean;
    /** Accumulated final transcript text */
    transcript: string;
    /** Current partial/interim text */
    partialTranscript: string;
    /** Combined text for display */
    displayText: string;
    /** Current audio level (0-1) */
    audioLevel: number;
    /** Current error if any */
    error: STTError | null;

    // Actions
    /** Start recording */
    startRecording: () => Promise<void>;
    /** Stop recording and finalize transcript */
    stopRecording: () => Promise<string>;
    /** Cancel recording */
    cancelRecording: () => void;

    // Configuration state
    /** Whether STT is enabled in settings */
    isEnabled: boolean;
    /** Whether the local model is ready */
    isModelReady: boolean;
    /** Whether initializing */
    isInitializing: boolean;
    /** Current model being used */
    currentModel: WhisperModelSize | null;
}

// =============================================================================
// Main Hook
// =============================================================================

export function useSTT(options: UseSTTOptions = {}): UseSTTReturn {
    // Get settings from store
    const sttEnabled = useSetting('sttEnabled');
    const sttLocalModel = useSetting('sttLocalModel');
    const sttLanguage = useSetting('sttLanguage');
    const sttHapticFeedback = useSetting('sttHapticFeedback');

    // Provider and utilities refs
    const providerRef = React.useRef<ISTTProvider | null>(null);
    const audioCapture = React.useRef<AudioCapture | null>(null);
    const modelDownloader = React.useRef<ModelDownloader | null>(null);

    // State
    const [isRecording, setIsRecording] = React.useState(false);
    const [isProcessing, setIsProcessing] = React.useState(false);
    const [isInitializing, setIsInitializing] = React.useState(false);
    const [isModelReady, setIsModelReady] = React.useState(false);
    const [transcript, setTranscript] = React.useState('');
    const [partialTranscript, setPartialTranscript] = React.useState('');
    const [audioLevel, setAudioLevel] = React.useState(0);
    const [error, setError] = React.useState<STTError | null>(null);

    // Derived state
    const displayText = React.useMemo(() => {
        const parts = [transcript, partialTranscript].filter(Boolean);
        return parts.join(' ').trim();
    }, [transcript, partialTranscript]);

    // ==========================================================================
    // Initialization
    // ==========================================================================

    React.useEffect(() => {
        let mounted = true;

        const initialize = async () => {
            if (!sttEnabled) return;

            setIsInitializing(true);

            try {
                // Initialize model downloader
                modelDownloader.current = getModelDownloader();

                // Check if model is downloaded
                const modelState = await modelDownloader.current.getModelState(sttLocalModel);

                if (modelState.status !== 'downloaded' || !modelState.filePath) {
                    if (mounted) {
                        setIsModelReady(false);
                        setIsInitializing(false);
                    }
                    return;
                }

                // Initialize audio capture
                audioCapture.current = getAudioCapture();
                await audioCapture.current.initialize();

                // Initialize local Whisper provider
                const whisperProvider = new WhisperLocalProvider();
                whisperProvider.setModelPaths({
                    modelPath: modelState.filePath,
                    coreMLPath: modelState.coreMLPath,
                });

                // Create audio recorder adapter
                whisperProvider.setAudioRecorder({
                    start: async () => {
                        await audioCapture.current?.start({
                            onAudioLevel: (level) => {
                                if (mounted) setAudioLevel(level);
                            },
                        });
                    },
                    stop: async () => {
                        return audioCapture.current?.stop() ?? '';
                    },
                    cancel: () => {
                        audioCapture.current?.cancel();
                    },
                });

                await whisperProvider.initialize({
                    language: options.language ?? sttLanguage,
                });

                providerRef.current = whisperProvider;

                if (mounted) {
                    setIsModelReady(true);
                    setIsInitializing(false);
                }

            } catch (err) {
                console.error('STT initialization error:', err);
                if (mounted) {
                    setError({
                        code: 'model_load_failed',
                        message: err instanceof Error ? err.message : String(err),
                        recoverable: true,
                    });
                    setIsInitializing(false);
                }
            }
        };

        initialize();

        return () => {
            mounted = false;
            providerRef.current?.dispose().catch(console.warn);
        };
    }, [sttEnabled, sttLocalModel, sttLanguage, options.language]);

    // ==========================================================================
    // Actions
    // ==========================================================================

    const startRecording = React.useCallback(async () => {
        if (isRecording || isProcessing) return;

        // Check microphone permission
        const permissionResult = await requestMicrophonePermission();
        if (!permissionResult.granted) {
            showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
            return;
        }

        if (!providerRef.current || !providerRef.current.isReady()) {
            setError({
                code: 'model_not_ready',
                message: 'Speech recognition model is not ready. Please download it in settings.',
                recoverable: false,
            });
            options.onError?.({
                code: 'model_not_ready',
                message: 'Model not ready',
                recoverable: false,
            });
            return;
        }

        // Reset state
        setTranscript('');
        setPartialTranscript('');
        setError(null);
        setAudioLevel(0);
        setIsRecording(true);

        try {
            await providerRef.current.startSession({
                onTranscript: (result: TranscriptResult) => {
                    if (result.isFinal) {
                        setTranscript(prev => {
                            const newText = prev ? `${prev} ${result.text}` : result.text;
                            options.onTranscript?.(newText);
                            return newText;
                        });
                        setPartialTranscript('');
                    } else {
                        setPartialTranscript(result.text);
                        options.onPartialTranscript?.(result.text);
                    }
                },
                onAudioLevel: (data) => {
                    setAudioLevel(data.level);
                },
                onStateChange: (state: STTSessionState) => {
                    if (state.status === 'error' && state.error) {
                        setError(state.error);
                        options.onError?.(state.error);
                    }
                },
                onError: (err: STTError) => {
                    setError(err);
                    options.onError?.(err);
                },
            });

        } catch (err) {
            setIsRecording(false);
            const sttError: STTError = {
                code: 'audio_error',
                message: err instanceof Error ? err.message : String(err),
                recoverable: true,
            };
            setError(sttError);
            options.onError?.(sttError);
        }
    }, [isRecording, isProcessing, options]);

    const stopRecording = React.useCallback(async (): Promise<string> => {
        if (!isRecording || !providerRef.current) {
            return displayText;
        }

        setIsRecording(false);
        setIsProcessing(true);

        try {
            const finalText = await providerRef.current.stopSession();

            setTranscript(finalText);
            setPartialTranscript('');
            setIsProcessing(false);

            options.onComplete?.(finalText);

            // Clean up audio file
            await audioCapture.current?.cleanupLastRecording();

            return finalText;

        } catch (err) {
            setIsProcessing(false);
            const sttError: STTError = {
                code: 'provider_error',
                message: err instanceof Error ? err.message : String(err),
                recoverable: true,
            };
            setError(sttError);
            options.onError?.(sttError);
            return displayText;
        }
    }, [isRecording, displayText, options]);

    const cancelRecording = React.useCallback(() => {
        if (!isRecording) return;

        providerRef.current?.cancelSession();

        setIsRecording(false);
        setIsProcessing(false);
        setTranscript('');
        setPartialTranscript('');
        setAudioLevel(0);

        // Clean up audio file
        audioCapture.current?.cleanupLastRecording().catch(console.warn);

        options.onCancel?.();
    }, [isRecording, options]);

    // ==========================================================================
    // Return
    // ==========================================================================

    return {
        // State
        isRecording,
        isProcessing,
        transcript,
        partialTranscript,
        displayText,
        audioLevel,
        error,

        // Actions
        startRecording,
        stopRecording,
        cancelRecording,

        // Configuration
        isEnabled: sttEnabled,
        isModelReady,
        isInitializing,
        currentModel: sttLocalModel,
    };
}

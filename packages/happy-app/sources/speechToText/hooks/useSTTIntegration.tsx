/**
 * useSTTIntegration Hook
 *
 * Integration hook for using STT in chat sessions.
 * Handles the logic for switching between STT and realtime voice.
 */

import * as React from 'react';
import { useSTT, UseSTTOptions, UseSTTReturn } from './useSTT';
import { useSetting } from '@/sync/storage';
import { STTOverlay } from '../components/STTOverlay';

export interface UseSTTIntegrationOptions extends UseSTTOptions {
    /** Callback to append text to input */
    onTextReady?: (text: string) => void;
    /** Fallback handler when STT is not available */
    onFallback?: () => void;
}

export interface UseSTTIntegrationReturn extends UseSTTReturn {
    /** Handle mic button press */
    handleMicPress: () => void;
    /** Render the STT overlay if recording */
    renderOverlay: () => React.ReactNode;
    /** Whether to use STT (vs fallback to realtime voice) */
    shouldUseSTT: boolean;
}

/**
 * Hook for integrating STT into chat sessions.
 *
 * Usage:
 * ```tsx
 * const {
 *   handleMicPress,
 *   renderOverlay,
 *   shouldUseSTT,
 *   isRecording,
 * } = useSTTIntegration({
 *   onTextReady: (text) => setInputValue(prev => prev + ' ' + text),
 *   onFallback: () => startRealtimeVoice(),
 * });
 *
 * // In JSX:
 * <AgentInput
 *   onMicPress={handleMicPress}
 *   isMicActive={isRecording}
 *   // ...
 * />
 * {renderOverlay()}
 * ```
 */
export function useSTTIntegration(options: UseSTTIntegrationOptions = {}): UseSTTIntegrationReturn {
    const { onTextReady, onFallback, ...sttOptions } = options;

    // Get STT settings
    const sttEnabled = useSetting('sttEnabled');

    // Use STT hook
    const stt = useSTT({
        ...sttOptions,
        onComplete: (text) => {
            if (text.trim()) {
                onTextReady?.(text.trim());
            }
            sttOptions.onComplete?.(text);
        },
    });

    // Determine if we should use STT
    const shouldUseSTT = sttEnabled && stt.isModelReady;

    // Handle mic button press
    const handleMicPress = React.useCallback(() => {
        if (shouldUseSTT) {
            if (stt.isRecording) {
                stt.stopRecording();
            } else {
                stt.startRecording();
            }
        } else {
            // Fallback to existing voice functionality
            onFallback?.();
        }
    }, [shouldUseSTT, stt.isRecording, stt.startRecording, stt.stopRecording, onFallback]);

    // Handle overlay confirm
    const handleConfirm = React.useCallback(async () => {
        const text = await stt.stopRecording();
        // onComplete callback will handle the text
    }, [stt.stopRecording]);

    // Render overlay function
    const renderOverlay = React.useCallback(() => {
        if (!stt.isRecording && !stt.isProcessing) {
            return null;
        }

        return (
            <STTOverlay
                visible={stt.isRecording || stt.isProcessing}
                transcript={stt.displayText}
                audioLevel={stt.audioLevel}
                isProcessing={stt.isProcessing}
                onCancel={stt.cancelRecording}
                onConfirm={handleConfirm}
            />
        );
    }, [
        stt.isRecording,
        stt.isProcessing,
        stt.displayText,
        stt.audioLevel,
        stt.cancelRecording,
        handleConfirm,
    ]);

    return {
        ...stt,
        handleMicPress,
        renderOverlay,
        shouldUseSTT,
    };
}

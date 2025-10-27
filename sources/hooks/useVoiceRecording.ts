import { useCallback, useRef, useState } from 'react';
import { Audio } from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { useLocalVAD } from './useLocalVAD';
import { useSetting } from '@/sync/storage';

export interface VoiceRecordingResult {
    uri: string;
    duration: number;
}

export interface UseVoiceRecordingReturn {
    isRecording: boolean;
    isSpeaking?: boolean; // Whether speech is currently being detected (when VAD is enabled)
    startRecording: () => Promise<void>;
    stopRecording: () => Promise<VoiceRecordingResult | null>;
    cancelRecording: () => Promise<void>;
}

/**
 * Hook for managing voice recording using expo-audio
 *
 * @example
 * const { isRecording, startRecording, stopRecording } = useVoiceRecording();
 *
 * // Start recording
 * await startRecording();
 *
 * // Stop and get result
 * const result = await stopRecording();
 * if (result) {
 *   console.log('Recording saved at:', result.uri);
 *   console.log('Duration:', result.duration, 'ms');
 * }
 */
export function useVoiceRecording(): UseVoiceRecordingReturn {
    const [isRecording, setIsRecording] = useState(false);
    const recordingRef = useRef<Audio.Recording | null>(null);

    // Read VAD setting
    const vadEnabled = useSetting('experimentalLocalVAD');

    // Prevent re-entry during auto-stop
    const isAutoStoppingRef = useRef(false);

    // Callback refs to avoid dependency issues
    const stopRecordingRef = useRef<(() => Promise<VoiceRecordingResult | null>) | null>(null);

    // Initialize VAD hook
    const vad = useLocalVAD({
        enabled: vadEnabled || false,
        onSpeechStart: () => {
            console.log('[VoiceRecording] Speech detected, continuing recording...');
        },
        onSpeechEnd: async () => {
            console.log('[VoiceRecording] Silence detected, stopping recording automatically...');

            // Prevent re-entry
            if (isAutoStoppingRef.current) {
                console.log('[VoiceRecording] Already auto-stopping, skipping...');
                return;
            }

            isAutoStoppingRef.current = true;

            try {
                // Auto-stop recording when VAD detects speech end
                if (stopRecordingRef.current) {
                    await stopRecordingRef.current();
                }
            } finally {
                isAutoStoppingRef.current = false;
            }
        },
    });

    const startRecording = useCallback(async () => {
        try {
            // Request permissions
            const { granted } = await Audio.requestPermissionsAsync();
            if (!granted) {
                throw new Error('Microphone permission not granted');
            }

            // Configure audio mode for recording
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
            });

            // Create and start recording
            const { recording } = await Audio.Recording.createAsync(
                Audio.RecordingOptionsPresets.HIGH_QUALITY
            );

            recordingRef.current = recording;
            setIsRecording(true);
            isAutoStoppingRef.current = false;

            console.log('Recording started');

            // Start VAD if enabled
            if (vadEnabled) {
                try {
                    vad.start();
                    console.log('[VoiceRecording] VAD started');
                } catch (vadError) {
                    console.error('[VoiceRecording] Failed to start VAD:', vadError);
                    // Continue recording even if VAD fails
                }
            }
        } catch (error) {
            console.error('Failed to start recording:', error);
            setIsRecording(false);
            throw error;
        }
    }, [vadEnabled, vad]);

    const stopRecording = useCallback(async (): Promise<VoiceRecordingResult | null> => {
        try {
            if (!recordingRef.current) {
                console.warn('No active recording to stop');
                return null;
            }

            const recording = recordingRef.current;

            // Stop VAD first if enabled
            if (vadEnabled) {
                try {
                    vad.pause();
                    console.log('[VoiceRecording] VAD paused');
                } catch (vadError) {
                    console.error('[VoiceRecording] Failed to pause VAD:', vadError);
                    // Continue even if VAD pause fails
                }
            }

            // Stop recording
            await recording.stopAndUnloadAsync();

            // Reset audio mode
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
            });

            // Get recording URI and status
            const uri = recording.getURI();
            const status = await recording.getStatusAsync();

            recordingRef.current = null;
            setIsRecording(false);

            if (!uri) {
                console.warn('Recording URI is null');
                return null;
            }

            console.log('Recording stopped:', {
                uri,
                duration: status.durationMillis
            });

            return {
                uri,
                duration: status.durationMillis || 0
            };
        } catch (error) {
            console.error('Failed to stop recording:', error);
            recordingRef.current = null;
            setIsRecording(false);
            throw error;
        }
    }, [vadEnabled, vad]);

    // Update the ref when stopRecording changes
    stopRecordingRef.current = stopRecording;

    const cancelRecording = useCallback(async () => {
        try {
            if (!recordingRef.current) {
                return;
            }

            const recording = recordingRef.current;
            const uri = recording.getURI();

            // Stop VAD if enabled
            if (vadEnabled) {
                try {
                    vad.pause();
                    console.log('[VoiceRecording] VAD paused during cancel');
                } catch (vadError) {
                    console.error('[VoiceRecording] Failed to pause VAD during cancel:', vadError);
                }
            }

            // Stop recording
            await recording.stopAndUnloadAsync();

            // Reset audio mode
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
            });

            // Delete the recording file if it exists
            if (uri) {
                await FileSystem.deleteAsync(uri, { idempotent: true });
                console.log('Recording cancelled and file deleted');
            }

            recordingRef.current = null;
            setIsRecording(false);
            isAutoStoppingRef.current = false;
        } catch (error) {
            console.error('Failed to cancel recording:', error);
            recordingRef.current = null;
            setIsRecording(false);
            throw error;
        }
    }, [vadEnabled, vad]);

    return {
        isRecording,
        isSpeaking: vad.isSpeaking, // Expose VAD speaking state
        startRecording,
        stopRecording,
        cancelRecording
    };
}

/**
 * useVoiceInput Hook - Native Platform Implementation
 *
 * Uses react-native-audio-api for audio recording on iOS/Android.
 * Accumulates PCM16 audio data and converts to WAV base64 for ASR upload.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { AudioRecorder, AudioManager } from 'react-native-audio-api';
import { fromByteArray } from 'react-native-quick-base64';
import { ASRService } from '@/asr';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import type {
    VoiceInputState,
    GestureThresholds,
    VoiceInputParams,
} from '@/asr/types';
import {
    DEFAULT_GESTURE_THRESHOLDS,
    DEFAULT_VOICE_INPUT_PARAMS,
} from '@/asr/types';

// Audio constants matching StepFun requirements
const TARGET_SAMPLE_RATE = 24000;
const DEFAULT_RECORD_SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const FRAME_SIZE = 4096;

export interface UseVoiceInputOptions {
    onTranscriptionComplete?: (text: string, mode: 'send' | 'text') => void;
    onCancel?: () => void;
    gestureThresholds?: Partial<GestureThresholds>;
    params?: Partial<VoiceInputParams>;
}

export interface UseVoiceInputReturn {
    state: VoiceInputState;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
    cancelRecording: () => void;
    updateGesture: (dx: number, dy: number) => void;
    isASRAvailable: boolean;
}

/**
 * Native audio data format (base64)
 */
type NativeAudioData = {
    base64: string;
    mimeType: string;
    fileName: string;
};

/**
 * Convert PCM16 Int16Array to WAV ArrayBuffer
 */
function pcm16ToWavBuffer(pcmData: Int16Array, sampleRate: number, channels: number): ArrayBuffer {
    const bytesPerSample = 2;
    const dataLength = pcmData.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true); // ByteRate
    view.setUint16(32, channels * bytesPerSample, true); // BlockAlign
    view.setUint16(34, BIT_DEPTH, true); // BitsPerSample
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    // Write PCM data
    const pcmView = new Int16Array(buffer, 44);
    pcmView.set(pcmData);

    return buffer;
}

/**
 * Convert ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return fromByteArray(new Uint8Array(buffer));
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
    const {
        onTranscriptionComplete,
        onCancel,
        gestureThresholds = {},
        params = {},
    } = options;

    const thresholds: GestureThresholds = {
        ...DEFAULT_GESTURE_THRESHOLDS,
        ...gestureThresholds,
    };

    const voiceParams: VoiceInputParams = {
        ...DEFAULT_VOICE_INPUT_PARAMS,
        ...params,
    };

    const [state, setState] = useState<VoiceInputState>({
        isRecording: false,
        isTranscribing: false,
        transcribedText: '',
        gestureZone: 'send',
        recordingDuration: 0,
        audioLevel: 0,
        error: null,
    });

    // Refs
    const recorderRef = useRef<AudioRecorder | null>(null);
    const audioChunksRef = useRef<Int16Array[]>([]);
    const startTimeRef = useRef<number>(0);
    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const uploadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const noAudioTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const audioLevelRef = useRef<number>(0);
    const audioEventCountRef = useRef<number>(0);
    const recordingSampleRateRef = useRef<number>(DEFAULT_RECORD_SAMPLE_RATE);
    const resampleStateRef = useRef<{ pos: number; prev: number; hasPrev: boolean }>({
        pos: 0,
        prev: 0,
        hasPrev: false,
    });
    const isRecordingRef = useRef<boolean>(false);

    const isASRAvailable = ASRService.isAvailable();

    /**
     * Get accumulated audio as base64 AudioData for ASR upload
     */
    const getAccumulatedAudio = useCallback((): NativeAudioData | null => {
        if (audioChunksRef.current.length === 0) {
            return null;
        }

        // Calculate total length
        let totalLength = 0;
        for (const chunk of audioChunksRef.current) {
            totalLength += chunk.length;
        }

        // Combine all chunks
        const combined = new Int16Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunksRef.current) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        // Convert to WAV buffer, then to base64
        const wavBuffer = pcm16ToWavBuffer(combined, TARGET_SAMPLE_RATE, CHANNELS);
        const base64 = arrayBufferToBase64(wavBuffer);

        return {
            base64,
            mimeType: 'audio/wav',
            fileName: 'audio.wav',
        };
    }, []);

    /**
     * Upload accumulated audio to ASR
     */
    const uploadToASR = useCallback(async () => {
        const audioData = getAccumulatedAudio();
        if (!audioData || audioData.base64.length < 6700) {
            return;
        }

        setState(prev => ({ ...prev, isTranscribing: true }));

        try {
            const result = await ASRService.transcribe(audioData);
            setState(prev => ({
                ...prev,
                transcribedText: result.text,
                isTranscribing: false,
            }));
        } catch (error) {
            console.error('[useVoiceInput] ASR error:', error);
            setState(prev => ({
                ...prev,
                isTranscribing: false,
                error: error instanceof Error ? error.message : 'ASR failed',
            }));
        }
    }, [getAccumulatedAudio]);

    /**
     * Start periodic ASR uploads
     */
    const startPeriodicUpload = useCallback(() => {
        const firstUploadTimeout = setTimeout(() => {
            uploadToASR();

            uploadIntervalRef.current = setInterval(() => {
                uploadToASR();
            }, voiceParams.uploadInterval);
        }, voiceParams.initialUploadDelay);

        uploadIntervalRef.current = firstUploadTimeout as unknown as ReturnType<typeof setInterval>;
    }, [uploadToASR, voiceParams.initialUploadDelay, voiceParams.uploadInterval]);

    /**
     * Stop periodic ASR uploads
     */
    const stopPeriodicUpload = useCallback(() => {
        if (uploadIntervalRef.current) {
            clearInterval(uploadIntervalRef.current);
            clearTimeout(uploadIntervalRef.current as unknown as ReturnType<typeof setTimeout>);
            uploadIntervalRef.current = null;
        }
    }, []);

    /**
     * Convert Float32Array to Int16Array
     */
    const floatToInt16 = useCallback((float32Array: Float32Array): Int16Array => {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }, []);

    const computeRms = useCallback((float32Array: Float32Array): number => {
        if (float32Array.length === 0) {
            return 0;
        }
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            const v = float32Array[i];
            sum += v * v;
        }
        return Math.sqrt(sum / float32Array.length);
    }, []);

    const resampleFloat32 = useCallback(
        (input: Float32Array, inputRate: number, outputRate: number): Float32Array => {
            if (inputRate === outputRate) {
                return input;
            }

            const ratio = inputRate / outputRate;
            let pos = resampleStateRef.current.pos;
            const maxOutput = Math.ceil((input.length + Math.abs(pos)) / ratio) + 1;
            const output = new Float32Array(maxOutput);
            let outIndex = 0;

            while (pos < input.length) {
                const i = Math.floor(pos);
                const frac = pos - i;
                const s0 = i < 0
                    ? (resampleStateRef.current.hasPrev ? resampleStateRef.current.prev : input[0])
                    : input[i];
                const s1 = i + 1 < input.length ? input[i + 1] : input[input.length - 1];

                output[outIndex++] = s0 + (s1 - s0) * frac;
                pos += ratio;
            }

            resampleStateRef.current.pos = pos - input.length;
            resampleStateRef.current.prev = input[input.length - 1];
            resampleStateRef.current.hasPrev = true;

            return output.subarray(0, outIndex);
        },
        []
    );

    /**
     * Start recording
     */
    const startRecording = useCallback(async () => {
        if (state.isRecording) {
            return;
        }

        try {
            const permissionResult = await requestMicrophonePermission();
            if (!permissionResult.granted) {
                showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
                setState(prev => ({
                    ...prev,
                    isRecording: false,
                    error: 'Microphone permission denied',
                }));
                return;
            }

            let status = await AudioManager.checkRecordingPermissions();
            if (status !== 'Granted') {
                status = await AudioManager.requestRecordingPermissions();
            }
            if (status !== 'Granted') {
                setState(prev => ({
                    ...prev,
                    isRecording: false,
                    error: 'Microphone permission denied',
                }));
                return;
            }

            if (Platform.OS === 'ios') {
                try {
                    AudioManager.setAudioSessionOptions({
                        iosCategory: 'playAndRecord',
                        iosMode: 'spokenAudio',
                        iosOptions: ['allowBluetooth', 'defaultToSpeaker'],
                        iosAllowHaptics: true,
                    });
                } catch {
                    // Ignore
                }
            }
            try {
                await AudioManager.setAudioSessionActivity(true);
            } catch {
                // Ignore
            }

            audioChunksRef.current = [];
            startTimeRef.current = Date.now();
            audioLevelRef.current = 0;
            audioEventCountRef.current = 0;
            resampleStateRef.current = { pos: 0, prev: 0, hasPrev: false };

            const preferredRate = AudioManager.getDevicePreferredSampleRate();
            const chosenRate = Number.isFinite(preferredRate) && preferredRate > 0
                ? Math.round(preferredRate)
                : DEFAULT_RECORD_SAMPLE_RATE;
            const recordingSampleRate = Platform.OS === 'android'
                ? chosenRate
                : DEFAULT_RECORD_SAMPLE_RATE;
            recordingSampleRateRef.current = recordingSampleRate;

            setState({
                isRecording: true,
                isTranscribing: false,
                transcribedText: '',
                gestureZone: 'send',
                recordingDuration: 0,
                audioLevel: 0,
                error: null,
            });
            isRecordingRef.current = true;

            // Create audio recorder
            const recorder = new AudioRecorder({
                sampleRate: recordingSampleRate,
                bufferLengthInSamples: FRAME_SIZE,
            });
            recorderRef.current = recorder;

            // Handle audio data
            recorder.onAudioReady((event) => {
                audioEventCountRef.current += 1;
                const sampleRate = event.buffer.sampleRate;
                let float32Data: Float32Array | null = null;
                try {
                    float32Data = event.buffer.getChannelData(0);
                } catch {
                    return;
                }

                if (!float32Data || float32Data.length === 0) {
                    return;
                }

                let processedData = float32Data;
                const targetRate = TARGET_SAMPLE_RATE;
                const inputRate = sampleRate || recordingSampleRateRef.current;
                if (inputRate !== targetRate) {
                    processedData = resampleFloat32(float32Data, inputRate, targetRate);
                }

                const int16Data = floatToInt16(processedData);
                audioChunksRef.current.push(int16Data);

                const rms = computeRms(float32Data);
                audioLevelRef.current = audioLevelRef.current * 0.7 + rms * 0.3;
            });

            // Start recording
            recorder.start();
            if (noAudioTimeoutRef.current) {
                clearTimeout(noAudioTimeoutRef.current);
            }
            noAudioTimeoutRef.current = setTimeout(() => {
                if (audioEventCountRef.current === 0 && isRecordingRef.current) {
                    console.warn('[useVoiceInput] No audio frames received');
                }
            }, 1200);

            // Start duration timer
            durationIntervalRef.current = setInterval(() => {
                const duration = Date.now() - startTimeRef.current;
                const level = audioLevelRef.current;
                setState(prev => ({ ...prev, recordingDuration: duration, audioLevel: level }));

                if (duration >= voiceParams.maxDuration) {
                    stopRecording();
                }
            }, 100);

            // Start periodic ASR uploads
            startPeriodicUpload();
        } catch (error) {
            console.error('[useVoiceInput] Failed to start recording:', error);
            setState(prev => ({
                ...prev,
                isRecording: false,
                error: error instanceof Error ? error.message : 'Failed to start recording',
            }));
        }
    }, [state.isRecording, floatToInt16, computeRms, resampleFloat32, startPeriodicUpload, voiceParams.maxDuration]);

    /**
     * Cleanup resources
     */
    const cleanup = useCallback(() => {
        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }

        stopPeriodicUpload();
        if (noAudioTimeoutRef.current) {
            clearTimeout(noAudioTimeoutRef.current);
            noAudioTimeoutRef.current = null;
        }

        if (recorderRef.current) {
            try {
                recorderRef.current.stop();
                recorderRef.current.disconnect();
            } catch {
                // Ignore cleanup errors
            }
            recorderRef.current = null;
        }
        try {
            AudioManager.setAudioSessionActivity(false);
        } catch {
            // Ignore cleanup errors
        }
        isRecordingRef.current = false;
        resampleStateRef.current = { pos: 0, prev: 0, hasPrev: false };
    }, [stopPeriodicUpload]);

    /**
     * Stop recording and process based on gesture zone
     */
    const stopRecording = useCallback(async () => {
        if (!state.isRecording) {
            return;
        }

        const currentZone = state.gestureZone;
        cleanup();

        if (currentZone === 'cancel') {
            setState(prev => ({
                ...prev,
                isRecording: false,
                transcribedText: '',
                audioLevel: 0,
            }));
            onCancel?.();
            return;
        }

        setState(prev => ({ ...prev, isRecording: false, isTranscribing: true, audioLevel: 0 }));

        try {
            const audioData = getAccumulatedAudio();
            if (audioData && audioData.base64.length > 6700) {
                const result = await ASRService.transcribe(audioData);
                const finalText = result.text.trim();

                setState(prev => ({
                    ...prev,
                    isTranscribing: false,
                    transcribedText: finalText,
                }));

                if (finalText) {
                    onTranscriptionComplete?.(finalText, currentZone === 'text' ? 'text' : 'send');
                }
            } else {
                setState(prev => ({
                    ...prev,
                    isTranscribing: false,
                    error: 'Recording too short',
                }));
            }
        } catch (error) {
            console.error('[useVoiceInput] Final transcription failed:', error);
            setState(prev => ({
                ...prev,
                isTranscribing: false,
                error: error instanceof Error ? error.message : 'Transcription failed',
            }));
        }
    }, [state.isRecording, state.gestureZone, cleanup, getAccumulatedAudio, onTranscriptionComplete, onCancel]);

    /**
     * Cancel recording
     */
    const cancelRecording = useCallback(() => {
        if (!state.isRecording) {
            return;
        }

        cleanup();
        setState(prev => ({
            ...prev,
            isRecording: false,
            transcribedText: '',
            audioLevel: 0,
        }));
        onCancel?.();
    }, [state.isRecording, cleanup, onCancel]);

    /**
     * Update gesture position
     */
    const updateGesture = useCallback((dx: number, dy: number) => {
        let zone: 'send' | 'cancel' | 'text' = 'send';

        if (dy < thresholds.yThreshold) {
            if (dx <= -thresholds.xThreshold) {
                zone = 'cancel';
            } else if (dx >= thresholds.xThreshold) {
                zone = 'text';
            }
        }

        setState(prev => {
            if (prev.gestureZone !== zone) {
                return { ...prev, gestureZone: zone };
            }
            return prev;
        });
    }, [thresholds.yThreshold, thresholds.xThreshold]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup();
        };
    }, [cleanup]);

    return {
        state,
        startRecording,
        stopRecording,
        cancelRecording,
        updateGesture,
        isASRAvailable,
    };
}

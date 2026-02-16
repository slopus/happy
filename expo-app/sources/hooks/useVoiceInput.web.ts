/**
 * useVoiceInput Hook
 *
 * Provides voice input functionality with:
 * - Audio recording using MediaRecorder
 * - Cumulative upload to ASR for real-time transcription
 * - Gesture zone management (send/cancel/text)
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { ASRService } from '@/asr';
import type {
    VoiceInputState,
    GestureThresholds,
    VoiceInputParams,
} from '@/asr/types';
import {
    DEFAULT_GESTURE_THRESHOLDS,
    DEFAULT_VOICE_INPUT_PARAMS,
} from '@/asr/types';

export interface UseVoiceInputOptions {
    /** Callback when transcription is complete and ready to send */
    onTranscriptionComplete?: (text: string, mode: 'send' | 'text') => void;
    /** Callback when recording is cancelled */
    onCancel?: () => void;
    /** Custom gesture thresholds */
    gestureThresholds?: Partial<GestureThresholds>;
    /** Custom voice input parameters */
    params?: Partial<VoiceInputParams>;
}

export interface UseVoiceInputReturn {
    /** Current state */
    state: VoiceInputState;
    /** Start recording */
    startRecording: () => Promise<void>;
    /** Stop recording and process based on gesture zone */
    stopRecording: () => void;
    /** Cancel recording without sending */
    cancelRecording: () => void;
    /** Update gesture position (dx, dy from start point) */
    updateGesture: (dx: number, dy: number) => void;
    /** Check if ASR is available */
    isASRAvailable: boolean;
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

    // State
    const [state, setState] = useState<VoiceInputState>({
        isRecording: false,
        isTranscribing: false,
        transcribedText: '',
        gestureZone: 'send',
        recordingDuration: 0,
        audioLevel: 0,
        error: null,
    });

    // Refs for recording
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const startTimeRef = useRef<number>(0);
    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const uploadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isFirstUploadRef = useRef<boolean>(true);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const analyserDataRef = useRef<Float32Array | null>(null);
    const analyserByteDataRef = useRef<Uint8Array | null>(null);
    const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const audioLevelRef = useRef<number>(0);

    // Check if ASR is available
    const isASRAvailable = ASRService.isAvailable();

    /**
     * Get accumulated audio as a single Blob
     */
    const getAccumulatedAudio = useCallback((): Blob | null => {
        if (audioChunksRef.current.length === 0) {
            return null;
        }
        // Combine all chunks into a single blob
        const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
        return new Blob(audioChunksRef.current, { type: mimeType });
    }, []);

    /**
     * Upload accumulated audio to ASR
     */
    const uploadToASR = useCallback(async () => {
        const audioBlob = getAccumulatedAudio();
        if (!audioBlob || audioBlob.size < 1000) {
            return;
        }

        setState(prev => ({ ...prev, isTranscribing: true }));

        try {
            const result = await ASRService.transcribe(audioBlob);
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
        isFirstUploadRef.current = true;

        // First upload after initial delay
        const firstUploadTimeout = setTimeout(() => {
            uploadToASR();
            isFirstUploadRef.current = false;

            // Then start interval for subsequent uploads
            uploadIntervalRef.current = setInterval(() => {
                uploadToASR();
            }, voiceParams.uploadInterval);
        }, voiceParams.initialUploadDelay);

        // Store the timeout as interval (we'll clear both on stop)
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

    const computeRmsFloat = useCallback((float32Array: Float32Array): number => {
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            const v = float32Array[i];
            sum += v * v;
        }
        return Math.sqrt(sum / float32Array.length);
    }, []);

    const computeRmsByte = useCallback((byteArray: Uint8Array): number => {
        let sum = 0;
        for (let i = 0; i < byteArray.length; i++) {
            const v = (byteArray[i] - 128) / 128;
            sum += v * v;
        }
        return Math.sqrt(sum / byteArray.length);
    }, []);

    /**
     * Start recording
     */
    const startRecording = useCallback(async () => {
        if (state.isRecording) {
            return;
        }

        try {
            // Reset state
            audioChunksRef.current = [];
            startTimeRef.current = Date.now();
            audioLevelRef.current = 0;

            setState({
                isRecording: true,
                isTranscribing: false,
                transcribedText: '',
                gestureZone: 'send',
                recordingDuration: 0,
                audioLevel: 0,
                error: null,
            });

            // Request microphone permission
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            streamRef.current = stream;

            // Setup analyser for audio level detection
            try {
                const audioContext = new AudioContext();
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 1024;
                const source = audioContext.createMediaStreamSource(stream);
                source.connect(analyser);
                audioContextRef.current = audioContext;
                analyserRef.current = analyser;
                audioSourceRef.current = source;
                analyserDataRef.current = new Float32Array(analyser.fftSize);
                analyserByteDataRef.current = new Uint8Array(analyser.fftSize);
            } catch (error) {
                console.warn('[useVoiceInput] Failed to init analyser:', error);
            }

            // Determine MIME type
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : MediaRecorder.isTypeSupported('audio/mp4')
                        ? 'audio/mp4'
                        : 'audio/wav';

            // Create MediaRecorder
            const mediaRecorder = new MediaRecorder(stream, {
                mimeType,
                audioBitsPerSecond: 128000,
            });
            mediaRecorderRef.current = mediaRecorder;

            // Handle data available
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            // Start recording with small time slices for smooth cumulative upload
            mediaRecorder.start(500); // 500ms chunks

            // Start duration timer
            durationIntervalRef.current = setInterval(() => {
                const duration = Date.now() - startTimeRef.current;
                const analyser = analyserRef.current;
                if (analyser) {
                    if (analyser.getFloatTimeDomainData && analyserDataRef.current) {
                        analyser.getFloatTimeDomainData(analyserDataRef.current);
                        const rms = computeRmsFloat(analyserDataRef.current);
                        audioLevelRef.current = audioLevelRef.current * 0.7 + rms * 0.3;
                    } else if (analyserByteDataRef.current) {
                        analyser.getByteTimeDomainData(analyserByteDataRef.current);
                        const rms = computeRmsByte(analyserByteDataRef.current);
                        audioLevelRef.current = audioLevelRef.current * 0.7 + rms * 0.3;
                    }
                }
                const level = audioLevelRef.current;
                setState(prev => ({ ...prev, recordingDuration: duration, audioLevel: level }));

                // Auto-stop if max duration reached
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
    }, [state.isRecording, startPeriodicUpload, voiceParams.maxDuration, computeRmsFloat, computeRmsByte]);

    /**
     * Stop recording and cleanup
     */
    const cleanup = useCallback(() => {
        // Stop duration timer
        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }

        // Stop periodic upload
        stopPeriodicUpload();

        // Stop MediaRecorder
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        mediaRecorderRef.current = null;

        // Stop media stream
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }

        if (audioSourceRef.current) {
            audioSourceRef.current.disconnect();
            audioSourceRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        analyserRef.current = null;
        analyserDataRef.current = null;
        analyserByteDataRef.current = null;
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

        // For 'send' or 'text' zone, do final transcription
        setState(prev => ({ ...prev, isRecording: false, isTranscribing: true, audioLevel: 0 }));

        try {
            const audioBlob = getAccumulatedAudio();
            if (audioBlob && audioBlob.size > 1000) {
                const result = await ASRService.transcribe(audioBlob);
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
     * Cancel recording without sending
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

        // If finger moved up past threshold
        if (dy < thresholds.yThreshold) {
            // Left side = cancel, right side = text
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

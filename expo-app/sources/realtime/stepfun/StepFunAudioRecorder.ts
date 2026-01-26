/**
 * StepFun Audio Recorder for Native (iOS/Android)
 * Uses Web Audio API polyfill for real-time audio capture
 * Outputs base64 encoded PCM16 audio chunks
 */

import { fromByteArray } from 'react-native-quick-base64';
import { STEPFUN_CONSTANTS } from './constants';

export interface AudioRecorderCallbacks {
    onAudioData: (base64Audio: string) => void;
    onError: (error: Error) => void;
}

export class StepFunAudioRecorder {
    private audioContext: AudioContext | null = null;
    private isRecording: boolean = false;
    private callbacks: AudioRecorderCallbacks;
    private mediaStream: MediaStream | null = null;
    private processorNode: ScriptProcessorNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;

    constructor(callbacks: AudioRecorderCallbacks) {
        this.callbacks = callbacks;
    }

    async start(): Promise<void> {
        if (this.isRecording) {
            console.warn('[StepFunAudioRecorder] Already recording');
            return;
        }

        try {
            console.log('[StepFunAudioRecorder] Starting recording...');

            // Create audio context with target sample rate
            // Use global AudioContext which may be polyfilled in React Native
            const AudioContextClass = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
            if (!AudioContextClass) {
                throw new Error('AudioContext not available');
            }

            this.audioContext = new AudioContextClass({
                sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
            }) as AudioContext;

            // Get microphone stream
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('getUserMedia not available');
            }

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
                    channelCount: STEPFUN_CONSTANTS.AUDIO.CHANNELS,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // Create source from microphone
            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

            // Create script processor for real-time audio processing
            // Buffer size of 4096 gives ~170ms chunks at 24kHz
            this.processorNode = this.audioContext.createScriptProcessor(
                STEPFUN_CONSTANTS.AUDIO.FRAME_SIZE,
                STEPFUN_CONSTANTS.AUDIO.CHANNELS,
                STEPFUN_CONSTANTS.AUDIO.CHANNELS
            );

            this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
                if (!this.isRecording) return;

                const inputBuffer = event.inputBuffer.getChannelData(0);
                const pcm16Data = this.floatToPCM16(inputBuffer);
                const base64Audio = fromByteArray(pcm16Data);

                this.callbacks.onAudioData(base64Audio);
            };

            // Connect the audio pipeline
            this.sourceNode.connect(this.processorNode);
            this.processorNode.connect(this.audioContext.destination);

            this.isRecording = true;
            console.log('[StepFunAudioRecorder] Recording started');
        } catch (error) {
            console.error('[StepFunAudioRecorder] Failed to start recording:', error);
            this.callbacks.onError(error as Error);
            this.cleanup();
        }
    }

    stop(): void {
        if (!this.isRecording) {
            return;
        }

        console.log('[StepFunAudioRecorder] Stopping recording...');
        this.isRecording = false;
        this.cleanup();
        console.log('[StepFunAudioRecorder] Recording stopped');
    }

    private cleanup(): void {
        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode.onaudioprocess = null;
            this.processorNode = null;
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    /**
     * Convert Float32Array (range -1 to 1) to Uint8Array (PCM16)
     */
    private floatToPCM16(float32Array: Float32Array): Uint8Array {
        const int16Array = new Int16Array(float32Array.length);

        for (let i = 0; i < float32Array.length; i++) {
            // Clamp to -1..1 range
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            // Convert to 16-bit signed integer
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Return as Uint8Array for base64 encoding
        return new Uint8Array(int16Array.buffer);
    }

    getIsRecording(): boolean {
        return this.isRecording;
    }
}

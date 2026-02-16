/**
 * StepFun Audio Recorder for Native (iOS/Android)
 * Uses react-native-audio-api for real-time audio capture
 * Outputs base64 encoded PCM16 audio chunks
 */

import { AudioRecorder } from 'react-native-audio-api';
import { fromByteArray } from 'react-native-quick-base64';
import { STEPFUN_CONSTANTS } from './constants';

export interface AudioRecorderCallbacks {
    onAudioData: (base64Audio: string) => void;
    onError: (error: Error) => void;
}

export class StepFunAudioRecorder {
    private recorder: AudioRecorder | null = null;
    private isRecording: boolean = false;
    private isPaused: boolean = false;
    private isMuted: boolean = false;
    private callbacks: AudioRecorderCallbacks;

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

            // Create audio recorder with target sample rate
            this.recorder = new AudioRecorder({
                sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
                bufferLengthInSamples: STEPFUN_CONSTANTS.AUDIO.FRAME_SIZE,
            });

            // Register audio data callback
            let chunkCount = 0;
            this.recorder.onAudioReady((event) => {
                if (!this.isRecording || this.isPaused || this.isMuted) return;

                try {
                    // Get audio data from buffer
                    const float32Data = event.buffer.getChannelData(0);

                    // Calculate audio level (RMS)
                    let sum = 0;
                    let max = 0;
                    for (let i = 0; i < float32Data.length; i++) {
                        const abs = Math.abs(float32Data[i]);
                        sum += float32Data[i] * float32Data[i];
                        if (abs > max) max = abs;
                    }
                    const rms = Math.sqrt(sum / float32Data.length);

                    const pcm16Data = this.floatToPCM16(float32Data);
                    const base64Audio = fromByteArray(pcm16Data);

                    chunkCount++;
                    if (chunkCount <= 3) {
                        // Log first few bytes of PCM data and base64 prefix
                        const pcmPreview = Array.from(pcm16Data.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                        console.log(`[StepFunAudioRecorder] Chunk #${chunkCount}: rms=${rms.toFixed(4)}, max=${max.toFixed(4)}, pcmBytes=${pcm16Data.length}, base64Len=${base64Audio.length}`);
                        console.log(`[StepFunAudioRecorder] PCM preview: ${pcmPreview}`);
                        console.log(`[StepFunAudioRecorder] Base64 prefix: ${base64Audio.slice(0, 50)}`);
                    }

                    this.callbacks.onAudioData(base64Audio);
                } catch (error) {
                    console.error('[StepFunAudioRecorder] Error processing audio:', error);
                }
            });

            // Start recording
            this.recorder.start();
            this.isRecording = true;
            this.isPaused = false;
            console.log('[StepFunAudioRecorder] Recording started');
        } catch (error) {
            console.error('[StepFunAudioRecorder] Failed to start recording:', error);
            this.callbacks.onError(error as Error);
            this.cleanup();
        }
    }

    /**
     * Pause sending audio data (recorder keeps running to avoid restart latency)
     */
    pause(): void {
        if (this.isPaused) return;
        console.log('[StepFunAudioRecorder] Pausing audio capture');
        this.isPaused = true;
    }

    /**
     * Resume sending audio data
     */
    resume(): void {
        if (!this.isPaused) return;
        console.log('[StepFunAudioRecorder] Resuming audio capture');
        this.isPaused = false;
    }

    /**
     * Set user mute state (independent of AI pause)
     */
    setMuted(muted: boolean): void {
        console.log(`[StepFunAudioRecorder] Setting muted: ${muted}`);
        this.isMuted = muted;
    }

    getIsMuted(): boolean {
        return this.isMuted;
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
        if (this.recorder) {
            try {
                this.recorder.stop();
                this.recorder.disconnect();
            } catch {
                // Ignore cleanup errors
            }
            this.recorder = null;
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

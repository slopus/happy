/**
 * StepFun Audio Player for Native (iOS/Android)
 * Uses react-native-audio-api for real-time audio playback
 * Receives base64 encoded PCM16 audio and plays it
 */

import {
    AudioContext as RNAudioContext,
    AudioBuffer as RNAudioBuffer,
    AudioBufferSourceNode as RNAudioBufferSourceNode
} from 'react-native-audio-api';
import { toByteArray } from 'react-native-quick-base64';
import { STEPFUN_CONSTANTS } from './constants';

export class StepFunAudioPlayer {
    private audioContext: RNAudioContext | null = null;
    private audioQueue: RNAudioBuffer[] = [];
    private isPlaying: boolean = false;
    private nextPlayTime: number = 0;
    private onPlaybackStateChange?: (isPlaying: boolean) => void;
    private currentSource: RNAudioBufferSourceNode | null = null;

    constructor(onPlaybackStateChange?: (isPlaying: boolean) => void) {
        this.onPlaybackStateChange = onPlaybackStateChange;
    }

    async initialize(): Promise<void> {
        console.log('[StepFunAudioPlayer] Initializing...');

        this.audioContext = new RNAudioContext({
            sampleRate: STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE,
        });
        this.nextPlayTime = this.audioContext.currentTime;
        console.log('[StepFunAudioPlayer] Initialized');
    }

    /**
     * Add audio chunk to playback queue
     */
    addAudioChunk(base64Audio: string): void {
        if (!this.audioContext) {
            console.warn('[StepFunAudioPlayer] Not initialized');
            return;
        }

        try {
            // Decode base64 to Uint8Array
            const pcm16Data = toByteArray(base64Audio);

            // Convert PCM16 to Float32 for audio API
            const float32Data = this.pcm16ToFloat(pcm16Data);

            // Create audio buffer
            const audioBuffer = this.audioContext.createBuffer(
                STEPFUN_CONSTANTS.AUDIO.CHANNELS,
                float32Data.length,
                STEPFUN_CONSTANTS.AUDIO.SAMPLE_RATE
            );
            audioBuffer.getChannelData(0).set(float32Data);

            // Queue for playback
            this.audioQueue.push(audioBuffer);

            // Start playback if not already playing
            if (!this.isPlaying) {
                this.playNextChunk();
            }
        } catch (error) {
            console.error('[StepFunAudioPlayer] Error processing audio chunk:', error);
        }
    }

    private playNextChunk(): void {
        if (!this.audioContext || this.audioQueue.length === 0) {
            this.isPlaying = false;
            this.onPlaybackStateChange?.(false);
            return;
        }

        this.isPlaying = true;
        this.onPlaybackStateChange?.(true);

        const audioBuffer = this.audioQueue.shift()!;
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        this.currentSource = source;

        // Ensure smooth continuous playback
        const startTime = Math.max(this.nextPlayTime, this.audioContext.currentTime);
        source.start(startTime);
        this.nextPlayTime = startTime + audioBuffer.duration;

        source.onEnded = () => {
            this.currentSource = null;
            this.playNextChunk();
        };
    }

    /**
     * Convert PCM16 (Uint8Array) to Float32Array (range -1 to 1)
     */
    private pcm16ToFloat(pcm16Data: Uint8Array): Float32Array {
        // Create Int16Array view from the Uint8Array buffer
        const int16View = new Int16Array(
            pcm16Data.buffer,
            pcm16Data.byteOffset,
            pcm16Data.byteLength / 2
        );
        const float32Array = new Float32Array(int16View.length);

        for (let i = 0; i < int16View.length; i++) {
            // Convert from 16-bit signed integer to float
            float32Array[i] = int16View[i] / (int16View[i] < 0 ? 0x8000 : 0x7FFF);
        }

        return float32Array;
    }

    /**
     * Clear audio queue and stop playback
     */
    stop(): void {
        console.log('[StepFunAudioPlayer] Stopping playback');
        this.audioQueue = [];
        this.isPlaying = false;
        this.onPlaybackStateChange?.(false);

        if (this.currentSource) {
            try {
                this.currentSource.stop();
            } catch {
                // Ignore errors if already stopped
            }
            this.currentSource = null;
        }

        if (this.audioContext) {
            this.nextPlayTime = this.audioContext.currentTime;
        }
    }

    /**
     * Clean up resources
     */
    dispose(): void {
        console.log('[StepFunAudioPlayer] Disposing');
        this.stop();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }
}

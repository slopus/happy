/**
 * Audio Capture Utility
 *
 * Wraps expo-audio for recording audio suitable for Whisper transcription.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { AUDIO_CONFIG } from '../config';

// expo-audio types
type RecordingStatus = {
    isRecording: boolean;
    durationMillis: number;
    metering?: number;
};

type AudioRecording = {
    prepareToRecordAsync: (options: unknown) => Promise<void>;
    startAsync: () => Promise<void>;
    stopAndUnloadAsync: () => Promise<void>;
    getStatusAsync: () => Promise<RecordingStatus>;
    getURI: () => string | null;
    setOnRecordingStatusUpdate: (callback: ((status: RecordingStatus) => void) | null) => void;
};

type AudioModule = {
    Recording: new () => AudioRecording;
    setAudioModeAsync: (options: unknown) => Promise<void>;
    RecordingOptionsPresets: {
        HIGH_QUALITY: unknown;
    };
};

// =============================================================================
// Audio Capture Class
// =============================================================================

export interface AudioCaptureCallbacks {
    onAudioLevel?: (level: number) => void;
    onError?: (error: Error) => void;
}

export class AudioCapture {
    private recording: AudioRecording | null = null;
    private audioModule: AudioModule | null = null;
    private callbacks: AudioCaptureCallbacks = {};
    private isRecording = false;
    private recordingUri: string | null = null;

    /**
     * Initialize the audio capture system
     */
    async initialize(): Promise<void> {
        try {
            // Dynamically import expo-audio
            const Audio = await import('expo-audio');
            this.audioModule = Audio as unknown as AudioModule;

            // Configure audio mode for recording
            await this.audioModule.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                staysActiveInBackground: false,
            });
        } catch (error) {
            throw new Error(
                `Failed to initialize audio: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Start recording audio
     */
    async start(callbacks?: AudioCaptureCallbacks): Promise<void> {
        if (!this.audioModule) {
            throw new Error('Audio module not initialized. Call initialize() first.');
        }

        if (this.isRecording) {
            throw new Error('Recording already in progress');
        }

        this.callbacks = callbacks || {};

        try {
            // Create new recording instance
            this.recording = new this.audioModule.Recording();

            // Configure recording options for Whisper compatibility
            const recordingOptions = this.getRecordingOptions();

            await this.recording.prepareToRecordAsync(recordingOptions);

            // Set up metering callback for audio levels
            this.recording.setOnRecordingStatusUpdate((status) => {
                if (status.isRecording && status.metering !== undefined) {
                    // Convert dB to 0-1 range
                    // Typical metering values range from -160 (silence) to 0 (max)
                    const normalizedLevel = Math.max(0, Math.min(1, (status.metering + 60) / 60));
                    this.callbacks.onAudioLevel?.(normalizedLevel);
                }
            });

            await this.recording.startAsync();
            this.isRecording = true;

        } catch (error) {
            this.cleanup();
            throw error;
        }
    }

    /**
     * Stop recording and return the audio file path
     */
    async stop(): Promise<string> {
        if (!this.recording || !this.isRecording) {
            throw new Error('No recording in progress');
        }

        try {
            await this.recording.stopAndUnloadAsync();
            this.isRecording = false;

            const uri = this.recording.getURI();
            if (!uri) {
                throw new Error('No recording URI available');
            }

            this.recordingUri = uri;

            // Convert to WAV format if needed (Whisper prefers WAV)
            const wavUri = await this.convertToWav(uri);

            return wavUri;

        } finally {
            this.cleanup();
        }
    }

    /**
     * Cancel recording without saving
     */
    cancel(): void {
        if (this.recording && this.isRecording) {
            try {
                this.recording.stopAndUnloadAsync().catch(console.warn);
            } catch (error) {
                console.warn('Error stopping recording:', error);
            }
        }
        this.cleanup();
    }

    /**
     * Check if currently recording
     */
    getIsRecording(): boolean {
        return this.isRecording;
    }

    /**
     * Clean up the last recording file
     */
    async cleanupLastRecording(): Promise<void> {
        if (this.recordingUri) {
            try {
                await FileSystem.deleteAsync(this.recordingUri, { idempotent: true });
            } catch (error) {
                console.warn('Error cleaning up recording:', error);
            }
            this.recordingUri = null;
        }
    }

    // ==========================================================================
    // Private Methods
    // ==========================================================================

    private getRecordingOptions(): unknown {
        // Platform-specific recording options optimized for Whisper
        if (Platform.OS === 'ios') {
            return {
                isMeteringEnabled: true,
                android: {
                    extension: '.wav',
                    outputFormat: 'DEFAULT',
                    audioEncoder: 'DEFAULT',
                    sampleRate: AUDIO_CONFIG.sampleRate,
                    numberOfChannels: AUDIO_CONFIG.channels,
                    bitRate: 128000,
                },
                ios: {
                    extension: '.wav',
                    outputFormat: 'LINEARPCM',
                    audioQuality: 'HIGH',
                    sampleRate: AUDIO_CONFIG.sampleRate,
                    numberOfChannels: AUDIO_CONFIG.channels,
                    bitRate: 128000,
                    linearPCMBitDepth: AUDIO_CONFIG.bitsPerSample,
                    linearPCMIsBigEndian: false,
                    linearPCMIsFloat: false,
                },
                web: {
                    mimeType: 'audio/wav',
                    bitsPerSecond: 128000,
                },
            };
        }

        // Android options
        return {
            isMeteringEnabled: true,
            android: {
                extension: '.wav',
                outputFormat: 1, // THREE_GPP or use default
                audioEncoder: 1, // AMR_NB or use default
                sampleRate: AUDIO_CONFIG.sampleRate,
                numberOfChannels: AUDIO_CONFIG.channels,
                bitRate: 128000,
            },
            ios: {
                extension: '.wav',
                outputFormat: 'LINEARPCM',
                audioQuality: 'HIGH',
                sampleRate: AUDIO_CONFIG.sampleRate,
                numberOfChannels: AUDIO_CONFIG.channels,
                bitRate: 128000,
                linearPCMBitDepth: AUDIO_CONFIG.bitsPerSample,
                linearPCMIsBigEndian: false,
                linearPCMIsFloat: false,
            },
            web: {
                mimeType: 'audio/wav',
                bitsPerSecond: 128000,
            },
        };
    }

    private async convertToWav(inputUri: string): Promise<string> {
        // expo-audio should already output in the correct format
        // If conversion is needed, we'd use ffmpeg-kit-react-native
        // For now, return as-is
        return inputUri;
    }

    private cleanup(): void {
        if (this.recording) {
            this.recording.setOnRecordingStatusUpdate(null);
            this.recording = null;
        }
        this.isRecording = false;
        this.callbacks = {};
    }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let audioCaptureInstance: AudioCapture | null = null;

/**
 * Get the singleton AudioCapture instance
 */
export function getAudioCapture(): AudioCapture {
    if (!audioCaptureInstance) {
        audioCaptureInstance = new AudioCapture();
    }
    return audioCaptureInstance;
}

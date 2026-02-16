import { NativeModule, requireNativeModule } from 'expo-modules-core';

interface AECManagerModule extends NativeModule {
    enableAEC(audioSessionId: number): void;
    disableAEC(): void;
    setVoiceCommunicationMode(): void;
    resetAudioMode(): void;
    isAECAvailable(): boolean;
    isNSAvailable(): boolean;
    isAGCAvailable(): boolean;
}

// Require the native module
const AECManagerNative = requireNativeModule<AECManagerModule>('AECManager');

/**
 * AEC (Acoustic Echo Cancellation) Manager
 * Provides access to system-level audio processing for voice communication
 */
export const AECManager = {
    /**
     * Enable AEC and related audio effects for the given audio session
     * @param audioSessionId The audio session ID (Android only, iOS uses system default)
     */
    enableAEC(audioSessionId: number = 0): void {
        AECManagerNative.enableAEC(audioSessionId);
    },

    /**
     * Disable and release all audio effects
     */
    disableAEC(): void {
        AECManagerNative.disableAEC();
    },

    /**
     * Set audio mode to voice communication for optimal AEC performance
     * On iOS, this sets AVAudioSession to voiceChat mode
     * On Android, this sets AudioManager to MODE_IN_COMMUNICATION
     */
    setVoiceCommunicationMode(): void {
        AECManagerNative.setVoiceCommunicationMode();
    },

    /**
     * Reset audio mode to normal
     */
    resetAudioMode(): void {
        AECManagerNative.resetAudioMode();
    },

    /**
     * Check if AEC is available on this device
     */
    isAECAvailable(): boolean {
        return AECManagerNative.isAECAvailable();
    },

    /**
     * Check if Noise Suppressor is available on this device (Android only)
     */
    isNSAvailable(): boolean {
        return AECManagerNative.isNSAvailable();
    },

    /**
     * Check if AGC is available on this device (Android only)
     */
    isAGCAvailable(): boolean {
        return AECManagerNative.isAGCAvailable();
    },
};

export default AECManager;

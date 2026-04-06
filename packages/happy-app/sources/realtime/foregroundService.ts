import { NativeModules, Platform } from 'react-native';

const VoiceForegroundService = NativeModules.VoiceForegroundService;

/**
 * Start the Android foreground service to keep the voice assistant
 * running when the app is backgrounded or the screen is off.
 * No-op on non-Android platforms.
 */
export async function startVoiceForegroundService(): Promise<void> {
    if (Platform.OS !== 'android' || !VoiceForegroundService) return;
    try {
        await VoiceForegroundService.start();
        console.log('[Voice] Foreground service started');
    } catch (error) {
        console.error('[Voice] Failed to start foreground service:', error);
    }
}

/**
 * Stop the Android foreground service.
 * No-op on non-Android platforms.
 */
export async function stopVoiceForegroundService(): Promise<void> {
    if (Platform.OS !== 'android' || !VoiceForegroundService) return;
    try {
        await VoiceForegroundService.stop();
        console.log('[Voice] Foreground service stopped');
    } catch (error) {
        console.error('[Voice] Failed to stop foreground service:', error);
    }
}

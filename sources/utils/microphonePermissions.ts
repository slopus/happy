import { Platform, Linking } from 'react-native';
import { Modal } from '@/modal';
import { AudioModule } from 'expo-audio';
import { t } from '@/text';

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain?: boolean;
}

/**
 * CRITICAL: Request microphone permissions BEFORE starting any audio session
 * Without this, first voice session WILL fail on iOS/Android
 *
 * Uses expo-audio (SDK 52+) - expo-av is deprecated
 */
export async function requestMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      // Web: Use navigator.mediaDevices API
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Important: Stop the stream immediately after getting permission
        stream.getTracks().forEach(track => track.stop());
        return { granted: true };
      } catch (error: any) {
        // User denied permission or browser doesn't support getUserMedia
        console.error('Web microphone permission denied:', error);
        return { granted: false, canAskAgain: error.name !== 'NotAllowedError' };
      }
    } else {
      // iOS and Android: Use expo-audio (SDK 52+)
      const result = await AudioModule.requestRecordingPermissionsAsync();

      if (result.granted) {
        // Configure audio mode for recording
        await AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });

        return { granted: true, canAskAgain: result.canAskAgain };
      }

      return { granted: false, canAskAgain: result.canAskAgain };
    }
  } catch (error) {
    console.error('Error requesting microphone permission:', error);
    return { granted: false };
  }
}

/**
 * Check current microphone permission status without prompting
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      // Web: Check permission status if available
      if ('permissions' in navigator && 'query' in navigator.permissions) {
        try {
          const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          return { granted: result.state === 'granted' };
        } catch {
          // Permission API not supported or microphone permission not queryable
          // We'll have to request to know
          return { granted: false, canAskAgain: true };
        }
      }
      return { granted: false, canAskAgain: true };
    } else {
      // iOS and Android: Use expo-audio (SDK 52+)
      const result = await AudioModule.getRecordingPermissionsAsync();
      return { granted: result.granted, canAskAgain: result.canAskAgain };
    }
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    return { granted: false };
  }
}

/**
 * Show appropriate error message when permission is denied
 */
export function showMicrophonePermissionDeniedAlert(canAskAgain: boolean = false) {
  const title = t('modals.microphoneAccessRequiredTitle');
  const message = canAskAgain
    ? t('modals.microphoneAccessRequiredRequestPermission')
    : t('modals.microphoneAccessRequiredEnableInSettings');

  if (Platform.OS === 'web') {
    // Web: Show browser-specific instructions
    Modal.alert(
      title,
      t('modals.microphoneAccessRequiredBrowserInstructions'),
      [{ text: t('common.ok') }]
    );
  } else {
    Modal.alert(title, message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('modals.openSettings'),
        onPress: () => {
          // Opens app settings on iOS/Android
          Linking.openSettings();
        }
      }
    ]);
  }
}

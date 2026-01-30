import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function hapticsError() {
    if (Platform.OS === 'web') return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {
        // Ignore haptics errors
    });
}

export function hapticsLight() {
    if (Platform.OS === 'web') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
        // Ignore haptics errors
    });
}
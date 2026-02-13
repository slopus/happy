import * as Haptics from 'expo-haptics';

export function hapticsError() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export function hapticsSuccess() {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function hapticsLight() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}
import { Platform } from 'react-native';
import { getDeviceType } from 'react-native-device-info';

const deviceType = getDeviceType();

export function isRunningOnMac(): boolean {
    if (Platform.OS !== 'ios') {
        return false;
    }

    if (deviceType === 'Desktop') {
        return true;
    }

    // Check if running on Mac Catalyst
    // @ts-ignore - isPad is not in the type definitions but exists at runtime
    return Platform.isPad && Platform.Version && typeof Platform.Version === 'string' &&
           Platform.Version.includes('Mac');
}

// Tauri v2 injects __TAURI_INTERNALS__ early in page lifecycle, before app code runs.
// Safe to call in module scope. Returns false on non-web platforms.
export function isTauri(): boolean {
    return Platform.OS === 'web' &&
        typeof window !== 'undefined' &&
        (window as any).__TAURI_INTERNALS__ !== undefined;
}

// Covers both Tauri desktop and Mac Catalyst
export function isDesktop(): boolean {
    return isTauri() || isRunningOnMac();
}
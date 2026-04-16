import { Dimensions, Platform } from 'react-native';
import { getDeviceType } from '@/utils/responsive';
import { isRunningOnMac, isDesktop } from '@/utils/platform';

// Calculate max width based on device type
function getMaxWidth(): number {
    if (isRunningOnMac()) {
        return Number.POSITIVE_INFINITY;
    }

    const deviceType = getDeviceType();

    // For phones, use the max dimension (width or height)
    if (deviceType === 'phone' && Platform.OS !== 'web') {
        const { width, height } = Dimensions.get('window');
        return Math.max(width, height);
    }

    // Desktop (Tauri) and tablets/web: 800px content width.
    // In three-column layout the center column is flex:1 (~680px),
    // so 800px is effectively unconstrained within the column.
    return 800;
}

// Calculate max width based on device type
function getMaxLayoutWidth(): number {
    if (isRunningOnMac()) {
        return 1400;
    }

    const deviceType = getDeviceType();

    // For phones, use the max dimension (width or height)
    if (deviceType === 'phone' && Platform.OS !== 'web') {
        const { width, height } = Dimensions.get('window');
        return Math.max(width, height);
    }

    // Desktop (Tauri) and tablets/web: 800px layout width.
    return 800;
}

export const layout = {
    maxWidth: getMaxLayoutWidth(),
    headerMaxWidth: getMaxWidth()
}
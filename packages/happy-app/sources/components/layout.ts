import { Dimensions, Platform } from 'react-native';
import { getDeviceType } from '@/utils/responsive';
import { isRunningOnMac, isDesktop } from '@/utils/platform';

// Calculate max width based on device type
function getMaxWidth(): number {
    // Desktop: content fills center column in three-column layout, no maxWidth needed
    if (isDesktop()) {
        return Number.POSITIVE_INFINITY;
    }

    const deviceType = getDeviceType();

    // For phones, use the max dimension (width or height)
    if (deviceType === 'phone' && Platform.OS !== 'web') {
        const { width, height } = Dimensions.get('window');
        return Math.max(width, height);
    }

    // For tablets and web, use 800px
    return 800;
}

// Calculate max width based on device type
function getMaxLayoutWidth(): number {
    // Desktop: content fills center column in three-column layout
    if (isDesktop()) {
        return Number.POSITIVE_INFINITY;
    }

    const deviceType = getDeviceType();

    // For phones, use the max dimension (width or height)
    if (deviceType === 'phone' && Platform.OS !== 'web') {
        const { width, height } = Dimensions.get('window');
        return Math.max(width, height);
    }

    // For tablets and web, use 800px
    return 800;
}

export const layout = {
    maxWidth: getMaxLayoutWidth(),
    headerMaxWidth: getMaxWidth()
}
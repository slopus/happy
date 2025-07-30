import { Dimensions, Platform } from 'react-native';
import { getDeviceType } from '@/utils/responsive';

// Calculate max width based on device type
function getMaxWidth(): number {
    const deviceType = getDeviceType();
    
    // For phones, use the max dimension (width or height)
    if (deviceType === 'phone' && Platform.OS !== 'web') {
        const { width, height } = Dimensions.get('window');
        return Math.max(width, height);
    }
    
    // For tablets and web, use 700px
    return 700;
}

export const layout = {
    maxWidth: getMaxWidth()
}
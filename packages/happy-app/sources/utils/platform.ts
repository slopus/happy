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
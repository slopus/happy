import { Platform } from 'react-native';

export function isMacCatalyst(): boolean {
    if (Platform.OS !== 'ios') {
        return false;
    }
    
    // Check if running on Mac Catalyst
    // @ts-ignore - isPad is not in the type definitions but exists at runtime
    return Platform.isPad && Platform.Version && typeof Platform.Version === 'string' && 
           Platform.Version.includes('Mac');
}

export function isRunningOnMac(): boolean {
    return isMacCatalyst();
}
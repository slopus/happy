import { Dimensions, Platform } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useMemo } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';
import { isRunningOnMac } from './platform';

// Re-export calculation functions for use in other components
export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };

// Get header height based on platform, device type, and orientation (wrapper for backward compatibility)
export function getHeaderHeight(isLandscape: boolean, deviceType: 'phone' | 'tablet'): number {
    return calculateHeaderHeight({
        platform: Platform.OS,
        isLandscape,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
        deviceType: Platform.OS === 'android' ? deviceType : undefined,
        isMacCatalyst: isRunningOnMac()
    });
}

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    const { width, height } = Dimensions.get('screen');

    const dimensions = calculateDeviceDimensions({
        widthPoints: width,
        heightPoints: height,
        pointsPerInch: Platform.OS === 'ios' ? 163 : 160
    });

    return determineDeviceType({
        diagonalInches: dimensions.diagonalInches,
        platform: Platform.OS,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : false
    });
}

// Hook to get device type (reactive to dimension changes)
export function useDeviceType(): 'phone' | 'tablet' {
    const { width, height } = useWindowDimensions();
    
    return useMemo(() => {
        const dimensions = calculateDeviceDimensions({
            widthPoints: width,
            heightPoints: height,
            pointsPerInch: Platform.OS === 'ios' ? 163 : 160
        });

        return determineDeviceType({
            diagonalInches: dimensions.diagonalInches,
            platform: Platform.OS,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : false
        });
    }, [width, height]);
}

// RN Dimensions retained the pre-rotation width on Android API 36. Unistyles
// reads live currentWindowMetrics on API 30+, but physical display bounds on
// older Android. Keep RN's window metrics elsewhere so legacy split-screen,
// iPad multi-window, and web resizing retain their existing window contract.
export function useLayoutDimensions(): Readonly<{ width: number; height: number }> {
    const window = useWindowDimensions();
    const { rt } = useUnistyles();
    const { width, height } = Platform.OS === 'android' && Platform.Version >= 30
        ? rt.screen
        : window;
    return { width, height };
}

// Tablet-style UI is a window layout, not a physical device classification.
// At 768 logical pixels the sidebar is 250px and leaves 518px for content.
// Use width alone: folding/resizing must adapt, but an Android keyboard reducing
// window height must not collapse the sidebar or change navigation chrome.
export function useIsTablet(): boolean {
    const { width } = useLayoutDimensions();
    return width >= 768;
}

// Hook to detect landscape orientation
export function useIsLandscape(): boolean {
    const { width, height } = useLayoutDimensions();
    return width > height;
}

// Hook to get header height based on platform, device type, and orientation
export function useHeaderHeight(): number {
    const isLandscape = useIsLandscape();
    const isTablet = useIsTablet();
    
    return useMemo(() => {
        return calculateHeaderHeight({
            platform: Platform.OS,
            isLandscape,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
            deviceType: Platform.OS === 'android' ? (isTablet ? 'tablet' : 'phone') : undefined,
            isMacCatalyst: isRunningOnMac()
        });
    }, [isLandscape, isTablet]);
}
import { Dimensions, Platform, PixelRatio } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useEffect, useState } from 'react';

// Breakpoints based on common device sizes
export const BREAKPOINTS = {
    sm: 640,   // Small devices
    md: 768,   // Tablets portrait
    lg: 1024,  // Tablets landscape
    xl: 1280,  // Large tablets
} as const;

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    const { width, height } = Dimensions.get('screen');
    const pixelDensity = PixelRatio.get();
    
    // Calculate diagonal size in inches (approximate)
    const widthInches = width / (pixelDensity * 160);
    const heightInches = height / (pixelDensity * 160);
    const diagonalInches = Math.sqrt(widthInches * widthInches + heightInches * heightInches);
    
    // Consider it a tablet if:
    // 1. Diagonal is >= 7 inches (typical tablet size)
    // 2. Or if it's an iPad (iOS specific check)
    if (Platform.OS === 'ios' && Platform.isPad) {
        return 'tablet';
    }
    
    // For Android and other platforms, use diagonal size
    // Most phones are under 7 inches diagonal
    return diagonalInches >= 7 ? 'tablet' : 'phone';
}

// Hook to detect if device is tablet
export function useIsTablet() {
    const [isTablet, setIsTablet] = useState(() => getDeviceType() === 'tablet');
    
    useEffect(() => {
        // Re-check on mount in case of dynamic changes
        setIsTablet(getDeviceType() === 'tablet');
    }, []);
    
    return isTablet;
}

// Hook to get current breakpoint
export function useBreakpoint() {
    const { width } = useWindowDimensions();
    
    if (width >= BREAKPOINTS.xl) return 'xl';
    if (width >= BREAKPOINTS.lg) return 'lg';
    if (width >= BREAKPOINTS.md) return 'md';
    return 'sm';
}

// Hook for responsive values
export function useResponsiveValue<T>(values: {
    phone?: T;
    tablet?: T;
    default: T;
}) {
    const isTablet = useIsTablet();
    
    if (isTablet && values.tablet !== undefined) {
        return values.tablet;
    }
    if (!isTablet && values.phone !== undefined) {
        return values.phone;
    }
    return values.default;
}

// Hook to detect landscape orientation
export function useIsLandscape() {
    const { width, height } = useWindowDimensions();
    return width > height;
}

// Check if running on web
export const isWeb = Platform.OS === 'web';

// Get safe area for split view
export function getSplitViewDimensions(totalWidth: number) {
    // Master (list) takes 35% on tablets, detail takes 65%
    const masterWidth = Math.floor(totalWidth * 0.35);
    const detailWidth = totalWidth - masterWidth;
    
    return {
        masterWidth,
        detailWidth,
        minMasterWidth: 320,
        maxMasterWidth: 400,
    };
}
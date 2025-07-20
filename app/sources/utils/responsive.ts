import { Dimensions, Platform } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useEffect, useState } from 'react';

// Breakpoints based on common device sizes
export const BREAKPOINTS = {
    sm: 640,   // Small devices
    md: 768,   // Tablets portrait
    lg: 1024,  // Tablets landscape
    xl: 1280,  // Large tablets
} as const;

// Device type detection
export function getDeviceType(width: number): 'phone' | 'tablet' {
    return width >= BREAKPOINTS.md ? 'tablet' : 'phone';
}

// Hook to detect if device is tablet
export function useIsTablet() {
    const { width } = useWindowDimensions();
    return getDeviceType(width) === 'tablet';
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
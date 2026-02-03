// Pure calculation functions for device dimensions
// These functions have no dependencies on React Native or platform-specific APIs

// Calculate device dimensions in inches
export function calculateDeviceDimensions(params: {
    widthPoints: number;  // Logical points (what RN Dimensions.get returns)
    heightPoints: number; // Logical points (what RN Dimensions.get returns)
    pointsPerInch?: number; // Default is 160 for Android, 163 for iOS
}): {
    widthInches: number;
    heightInches: number;
    diagonalInches: number;
} {
    const { widthPoints, heightPoints, pointsPerInch = 160 } = params;
    
    // React Native Dimensions are in points, not pixels
    // Points are density-independent units
    // On iOS: 1 point = 1/163 inch (Retina displays)
    // On Android: 1 point = 1/160 inch (dp/dip)
    // pixelDensity from PixelRatio.get() is the scale factor (e.g., 2x, 3x)
    // but it doesn't affect the inch calculation since we're already in points
    
    const widthInches = widthPoints / pointsPerInch;
    const heightInches = heightPoints / pointsPerInch;
    const diagonalInches = Math.sqrt(widthInches * widthInches + heightInches * heightInches);
    
    return {
        widthInches,
        heightInches,
        diagonalInches
    };
}

// Determine device type based on dimensions and platform
export function determineDeviceType(params: {
    diagonalInches: number;
    platform: string;
    isPad?: boolean;
    tabletThresholdInches?: number; // Default is 9 inches
}): 'phone' | 'tablet' {
    const { diagonalInches, platform, isPad, tabletThresholdInches = 9 } = params;
    
    // iOS-specific check: iPads with diagonal > 9" are tablets
    // This treats iPad Mini (7.9-8.3") as a phone
    if (platform === 'ios' && isPad) {
        return diagonalInches > 9 ? 'tablet' : 'phone';
    }
    
    // General check: devices with diagonal >= threshold are tablets
    // 9" threshold ensures foldables (typically 7-8") are treated as phones
    return diagonalInches >= tabletThresholdInches ? 'tablet' : 'phone';
}

// Calculate header height based on platform, device info, and orientation
export function calculateHeaderHeight(params: {
    platform: string;
    isLandscape: boolean;
    isPad?: boolean; // For iOS, use Platform.isPad
    deviceType?: 'phone' | 'tablet'; // For Android, use our device type detection
    isMacCatalyst?: boolean; // For Mac Catalyst apps
}): number {
    const { platform, isLandscape, isPad, deviceType, isMacCatalyst } = params;
    
    // Mac Catalyst: Use dedicated height for desktop environment
    if (isMacCatalyst) {
        return 56; // Mac Catalyst: 52 points (slightly taller than iOS for desktop feel)
    }
    
    // Web platform: Use Material Design height
    if (platform === 'web') {
        return 56; // Web: 64px for consistency with Material Design
    }
    
    if (platform === 'android') {
        // For Android, use our custom device type detection
        if (deviceType === 'phone') {
            return isLandscape ? 48 : 56; // Material Design: 48dp landscape, 56dp portrait
        }
        return 64; // Tablet: 64dp
    }
    
    // iOS: Use Platform.isPad for accurate native header height
    if (isPad) {
        return 50; // iPad (iOS 12+): 50 points
    }
    return 44; // iPhone: 44 points
}
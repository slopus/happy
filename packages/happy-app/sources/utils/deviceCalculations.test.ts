import { describe, it, expect } from 'vitest';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';

describe('responsive utilities', () => {
    describe('calculateDeviceDimensions', () => {
        it('should calculate dimensions correctly for standard phone (iPhone 13)', () => {
            // iPhone 13: 390x844 points (logical pixels)
            const result = calculateDeviceDimensions({
                widthPoints: 390,
                heightPoints: 844,
                pointsPerInch: 163 // iOS standard
            });

            expect(result.widthInches).toBeCloseTo(2.393, 3); // 390/163
            expect(result.heightInches).toBeCloseTo(5.178, 3); // 844/163
            expect(result.diagonalInches).toBeCloseTo(5.704, 2); // ~5.7 inches
        });

        it('should calculate dimensions correctly for tablet (iPad Pro 11")', () => {
            // iPad Pro 11": 834x1194 points
            const result = calculateDeviceDimensions({
                widthPoints: 834,
                heightPoints: 1194,
                pointsPerInch: 163 // iOS standard
            });

            expect(result.widthInches).toBeCloseTo(5.117, 3); // 834/163
            expect(result.heightInches).toBeCloseTo(7.325, 3); // 1194/163
            expect(result.diagonalInches).toBeCloseTo(8.935, 2); // ~8.9 inches (marketed as 11" diagonal screen)
        });

        it('should calculate dimensions correctly for Android phone', () => {
            // Typical Android phone: 360x800 dp (density-independent pixels)
            const result = calculateDeviceDimensions({
                widthPoints: 360,
                heightPoints: 800,
                pointsPerInch: 160 // Android standard
            });

            expect(result.widthInches).toBeCloseTo(2.25, 3); // 360/160
            expect(result.heightInches).toBeCloseTo(5.0, 3); // 800/160
            expect(result.diagonalInches).toBeCloseTo(5.483, 3); // ~5.5 inches
        });

        it('should calculate dimensions correctly for Android tablet', () => {
            // Typical Android tablet: 800x1280 dp
            const result = calculateDeviceDimensions({
                widthPoints: 800,
                heightPoints: 1280,
                pointsPerInch: 160 // Android standard
            });

            expect(result.widthInches).toBeCloseTo(5.0, 4);
            expect(result.heightInches).toBeCloseTo(8.0, 4);
            expect(result.diagonalInches).toBeCloseTo(9.434, 4); // ~9.4 inches
        });

        it('should handle custom points per inch values', () => {
            const result = calculateDeviceDimensions({
                widthPoints: 1000,
                heightPoints: 2000,
                pointsPerInch: 96 // Custom value
            });

            expect(result.widthInches).toBeCloseTo(10.417, 3);
            expect(result.heightInches).toBeCloseTo(20.833, 3);
            expect(result.diagonalInches).toBeCloseTo(23.292, 2);
        });

        it('should handle very small screens', () => {
            const result = calculateDeviceDimensions({
                widthPoints: 320,
                heightPoints: 480,
                pointsPerInch: 160
            });

            expect(result.widthInches).toBeCloseTo(2.0, 4);
            expect(result.heightInches).toBeCloseTo(3.0, 4);
            expect(result.diagonalInches).toBeCloseTo(3.6056, 3);
        });
    });

    describe('determineDeviceType', () => {
        it('should identify small iPads (iPad Mini) as phones', () => {
            const result = determineDeviceType({
                diagonalInches: 8.3, // iPad Mini diagonal
                platform: 'ios',
                isPad: true
            });

            expect(result).toBe('phone');
        });

        it('should identify large iPads as tablets', () => {
            const result = determineDeviceType({
                diagonalInches: 10.9, // iPad Air diagonal
                platform: 'ios',
                isPad: true
            });

            expect(result).toBe('tablet');
        });

        it('should identify large diagonal as tablet on Android', () => {
            const result = determineDeviceType({
                diagonalInches: 10.1, // Large Android tablet
                platform: 'android'
            });

            expect(result).toBe('tablet');
        });

        it('should identify small diagonal as phone on Android', () => {
            const result = determineDeviceType({
                diagonalInches: 5.5,
                platform: 'android'
            });

            expect(result).toBe('phone');
        });

        it('should respect custom tablet threshold', () => {
            const result1 = determineDeviceType({
                diagonalInches: 8.0,
                platform: 'android',
                tabletThresholdInches: 7.5
            });
            expect(result1).toBe('tablet');

            const result2 = determineDeviceType({
                diagonalInches: 8.0,
                platform: 'android',
                tabletThresholdInches: 8.5
            });
            expect(result2).toBe('phone');
        });

        it('should handle edge case at exact threshold', () => {
            const result = determineDeviceType({
                diagonalInches: 9.0,
                platform: 'android'
            });

            expect(result).toBe('tablet');
        });

        it('should handle iOS non-iPad devices', () => {
            const result = determineDeviceType({
                diagonalInches: 5.8, // iPhone size
                platform: 'ios',
                isPad: false
            });

            expect(result).toBe('phone');
        });

        it('should handle web platform', () => {
            const result = determineDeviceType({
                diagonalInches: 15, // Large monitor
                platform: 'web'
            });

            expect(result).toBe('tablet'); // Large screens are considered tablets
        });
    });

    describe('integration scenarios', () => {
        it('should correctly identify iPhone 13 Pro Max as phone', () => {
            // iPhone 13 Pro Max: 428x926 points
            const dimensions = calculateDeviceDimensions({
                widthPoints: 428,
                heightPoints: 926,
                pointsPerInch: 163
            });

            const deviceType = determineDeviceType({
                diagonalInches: dimensions.diagonalInches,
                platform: 'ios',
                isPad: false
            });

            expect(deviceType).toBe('phone');
            expect(dimensions.diagonalInches).toBeCloseTo(6.258, 2); // ~6.3 inches
            expect(dimensions.diagonalInches).toBeLessThan(7);
        });

        it('should correctly identify iPad Mini as phone', () => {
            // iPad Mini: 744x1133 points
            const dimensions = calculateDeviceDimensions({
                widthPoints: 744,
                heightPoints: 1133,
                pointsPerInch: 163
            });

            const deviceType = determineDeviceType({
                diagonalInches: dimensions.diagonalInches,
                platform: 'ios',
                isPad: true
            });

            expect(deviceType).toBe('phone'); // iPad Mini treated as phone
            expect(dimensions.diagonalInches).toBeCloseTo(8.316, 2); // ~8.3 inches
        });

        it('should handle foldable devices appropriately', () => {
            // Samsung Galaxy Fold (unfolded): typically around 673x884 dp
            const dimensions = calculateDeviceDimensions({
                widthPoints: 673,
                heightPoints: 884,
                pointsPerInch: 160
            });

            const deviceType = determineDeviceType({
                diagonalInches: dimensions.diagonalInches,
                platform: 'android'
            });

            // Unfolded state diagonal is around 6.9 inches
            expect(dimensions.diagonalInches).toBeCloseTo(6.944, 2);
            // With 9" threshold, it's classified as phone
            expect(deviceType).toBe('phone');
        });

        it('should identify Galaxy Z Fold as phone when unfolded', () => {
            // Galaxy Z Fold5 unfolded: 7.6" diagonal screen
            const deviceType = determineDeviceType({
                diagonalInches: 7.6,
                platform: 'android'
            });

            expect(deviceType).toBe('phone'); // Foldables are phones
        });
    });

    describe('calculateHeaderHeight', () => {
        it('should return correct height for Android phone in portrait', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'phone',
                isLandscape: false
            });
            expect(height).toBe(56);
        });

        it('should return correct height for Android phone in landscape', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'phone',
                isLandscape: true
            });
            expect(height).toBe(48);
        });

        it('should return correct height for Android tablet', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'tablet',
                isLandscape: false
            });
            expect(height).toBe(64);
        });

        it('should return correct height for iOS iPhone', () => {
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: false
            });
            expect(height).toBe(44);
        });

        it('should return correct height for iOS iPad', () => {
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: false
            });
            expect(height).toBe(50);
        });

        it('should ignore landscape for iOS devices', () => {
            const iPhonePortrait = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: false
            });
            const iPhoneLandscape = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: true
            });
            expect(iPhonePortrait).toBe(iPhoneLandscape);

            const iPadPortrait = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: false
            });
            const iPadLandscape = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: true
            });
            expect(iPadPortrait).toBe(iPadLandscape);
        });

        it('should use isPad for iOS and ignore deviceType', () => {
            // Even if deviceType says phone, if isPad is true, should return iPad height
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                deviceType: 'phone', // This should be ignored
                isLandscape: false
            });
            expect(height).toBe(50);
        });
    });
});
import { describe, expect, it } from 'vitest';
import { shouldShowFirstRunInstall, shouldSuppressTabletShell } from './firstRunOnboarding';

describe('first-run onboarding', () => {
    it.each([
        ['iPhone', false],
        ['iPad', true],
        ['Android phone', false],
        ['Android tablet', true],
    ])('shows the install step on %s', (_device, _isTablet) => {
        expect(shouldShowFirstRunInstall({
            isAuthenticated: true,
            isDataReady: true,
            machineCount: 0,
            isWeb: false,
            isRunningOnMac: false,
        })).toBe(true);
    });

    it('waits for synced machine data before deciding the account is new', () => {
        expect(shouldShowFirstRunInstall({
            isAuthenticated: true,
            isDataReady: false,
            machineCount: 0,
            isWeb: false,
            isRunningOnMac: false,
        })).toBe(false);
    });

    it('does not replace the established home or desktop/web empty states', () => {
        const base = {
            isAuthenticated: true,
            isDataReady: true,
            machineCount: 0,
            isWeb: false,
            isRunningOnMac: false,
        };

        expect(shouldShowFirstRunInstall({ ...base, machineCount: 1 })).toBe(false);
        expect(shouldShowFirstRunInstall({ ...base, isWeb: true })).toBe(false);
        expect(shouldShowFirstRunInstall({ ...base, isRunningOnMac: true })).toBe(false);
    });

    it('removes tablet chrome for install and keeps it removed while scanning', () => {
        const base = {
            isAuthenticated: true,
            isTablet: true,
            showInstallStep: false,
            isOnboardingRoute: false,
            isWeb: false,
            isRunningOnMac: false,
        };

        expect(shouldSuppressTabletShell({ ...base, showInstallStep: true })).toBe(true);
        expect(shouldSuppressTabletShell({ ...base, isOnboardingRoute: true })).toBe(true);
    });

    it('keeps normal tablet, phone, web, and desktop shells unchanged', () => {
        const base = {
            isAuthenticated: true,
            isTablet: true,
            showInstallStep: false,
            isOnboardingRoute: false,
            isWeb: false,
            isRunningOnMac: false,
        };

        expect(shouldSuppressTabletShell(base)).toBe(false);
        expect(shouldSuppressTabletShell({ ...base, isTablet: false, showInstallStep: true })).toBe(false);
        expect(shouldSuppressTabletShell({ ...base, isWeb: true, showInstallStep: true })).toBe(false);
        expect(shouldSuppressTabletShell({ ...base, isRunningOnMac: true, showInstallStep: true })).toBe(false);
    });
});
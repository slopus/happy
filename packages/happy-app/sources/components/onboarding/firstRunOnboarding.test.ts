import { describe, expect, it } from 'vitest';
import {
    resolveHomeEmptyState,
    shouldShowFirstRunInstall,
    shouldShowOfflineMachinesBanner,
    shouldSuppressTabletShell,
} from './firstRunOnboarding';

describe('home empty state', () => {
    const base = { visibleSessionCount: 0, hasArchivedSessions: false, machineCount: 1, onlineMachineCount: 1 };

    it('asks to link a computer when none is linked', () => {
        expect(resolveHomeEmptyState({ ...base, machineCount: 0, onlineMachineCount: 0 })).toBe('link');
    });

    it('shows the offline checklist when every linked computer is unreachable', () => {
        expect(resolveHomeEmptyState({ ...base, onlineMachineCount: 0 })).toBe('offline');
        expect(resolveHomeEmptyState({ ...base, onlineMachineCount: 0, hasArchivedSessions: true })).toBe('offline');
    });

    it('lists sessions whenever there are some, even with every computer offline', () => {
        expect(resolveHomeEmptyState({ ...base, visibleSessionCount: 3, onlineMachineCount: 0 })).toBe('list');
    });

    it('lets an archive-only account reach its archive when a computer is online', () => {
        expect(resolveHomeEmptyState({ ...base, hasArchivedSessions: true })).toBe('list');
        expect(resolveHomeEmptyState(base)).toBe('no-sessions');
    });
});

describe('offline machines banner', () => {
    it('shows only when computers exist and none is reachable', () => {
        expect(shouldShowOfflineMachinesBanner({ machineCount: 2, onlineMachineCount: 0 })).toBe(true);
        expect(shouldShowOfflineMachinesBanner({ machineCount: 2, onlineMachineCount: 1 })).toBe(false);
        expect(shouldShowOfflineMachinesBanner({ machineCount: 0, onlineMachineCount: 0 })).toBe(false);
    });
});

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
import * as React from 'react';
import { act } from 'react';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Native update identity has its own tests; these suites do not host Expo modules.
vi.mock('@/sync/nativeUpdate', () => ({ refreshNativeUpdateStatus: vi.fn(async () => ({ status: 'unsupported', available: false })) }));

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '1.7.1' }));
vi.mock('expo-updates', () => ({
    runtimeVersion: '24',
    checkForUpdateAsync: vi.fn(),
    fetchUpdateAsync: vi.fn(),
    reloadAsync: vi.fn(),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: {} }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/hooks/useUnifiedAuthQrCode', () => ({
    useUnifiedAuthQrCode: () => ({ connectAuthQrCode: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));
vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [],
    useLocalSettingMutable: (key: string) => [key === 'themePreference' ? 'light' : false, vi.fn()],
    useProfile: () => ({ connectedServices: [] }),
    useSetting: (key: string) => key === 'preferredLanguage' ? 'en' : false,
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/serverConfig', () => ({ isUsingCustomServer: () => false }));
vi.mock('@/track', () => ({ trackWhatsNewClicked: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() } }));
vi.mock('@/hooks/useMultiClick', () => ({ useMultiClick: (callback: unknown) => callback }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#00ff88',
                status: {
                    connected: '#00ff00',
                    connecting: '#ffff00',
                    disconnected: '#ff0000',
                },
                surface: '#111111',
                text: '#ffffff',
                textLink: '#00aaff',
                textSecondary: '#aaaaaa',
            },
        },
    }),
}));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: unknown) => [false, action] }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/sync/apiGithub', () => ({ disconnectGitHub: vi.fn(), getGitHubOAuthParams: vi.fn() }));
vi.mock('@/sync/apiServices', () => ({ disconnectService: vi.fn() }));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/components/MascotSwitcher', () => ({ MascotSwitcher: 'MascotSwitcher' }));
vi.mock('@/text', () => ({
    SUPPORTED_LANGUAGES: { en: {} },
    getLanguageNativeName: () => 'English',
    t: (key: string) => key,
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/components/settingsFeatureEntries', () => ({ getSettingsFeatureEntries: () => [] }));
const settingsNavigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/components/DesktopSettingsNavigation', () => ({
    useSettingsRouter: () => settingsNavigation,
}));

let SettingsView: React.ComponentType;
let restoreModuleResolution: (() => void) | undefined;

describe('SettingsView scan entry', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        const imageAssetMockPath = fileURLToPath(new URL('../../package.json', import.meta.url));
        const nodeModule = (await import('node:module')).default as unknown as {
            _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
        };
        const originalResolveFilename = nodeModule._resolveFilename;
        nodeModule._resolveFilename = (request, parent, isMain, options) => {
            if (request === '@/assets/images/icon-claude.png') {
                return imageAssetMockPath;
            }
            return originalResolveFilename(request, parent, isMain, options);
        };
        restoreModuleResolution = () => {
            nodeModule._resolveFilename = originalResolveFilename;
        };
        ({ SettingsView } = await import('./SettingsView'));
    });

    afterAll(() => restoreModuleResolution?.());

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => {
            renderer = TestRenderer.create(<SettingsView />);
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        consoleErrorSpy.mockRestore();
    });

    it('exposes exactly one authenticated scanner on the native settings home', () => {
        const scannerItems = renderer.root
            .findAllByType('Item')
            .filter((node: any) => node.props.title === 'settings.scanQrCodeToAuthenticate');

        expect(scannerItems).toHaveLength(1);
        expect(scannerItems[0].props.onPress).toEqual(expect.any(Function));
    });

    it('opens archived sessions from settings', () => {
        const archive = renderer.root.findByProps({ testID: 'settings-archive-entry' });
        expect(archive.props.title).toBe('sessionHistory.archiveTitle');
        act(() => archive.props.onPress());
        expect(settingsNavigation.push).toHaveBeenCalledWith('/settings/archive');
    });

    it('shows the installed native version and runtime when Expo config is unavailable', () => {
        const versionItem = renderer.root
            .findAllByType('Item')
            .find((node: any) => node.props.title === 'common.version');

        expect(versionItem?.props.detail).toBe('1.7.1 / runtime 24');
    });
});

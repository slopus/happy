import * as React from 'react';
import { act } from 'react';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StackActions, StackRouter } from '@react-navigation/routers';
// @ts-expect-error narrow renderer harness
import TestRenderer from 'react-test-renderer';
import type { EnvironmentDashboardController } from '@/hooks/useEnvironmentDashboard';
import { createDesktopModalRouter } from '@/navigation/desktopModalRouter';

const mocks = vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = { EventEmitter: EventTarget };
    return {
        state: {} as any,
        screenOptions: {} as Record<string, any>,
        descriptors: {} as Record<string, any>,
        confirm: vi.fn(),
        send: (_action: any) => {},
    };
});

vi.mock('react-native', () => ({
    Modal: 'Modal', Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    Pressable: 'Pressable', Text: 'Text', View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('@react-navigation/native', () => ({
    StackRouter,
    createNavigatorFactory: (component: any) => () => ({ Navigator: component }),
    useNavigationBuilder: () => ({
        state: mocks.state, descriptors: mocks.descriptors,
        navigation: { dispatch: (action: any) => mocks.send(action), goBack: () => mocks.send({ type: 'GO_BACK' }) },
        describe: vi.fn(), NavigationContent: React.Fragment,
    }),
}));
vi.mock('@react-navigation/native-stack', () => ({ NativeStackView: ({ state, descriptors }: any) => React.createElement(
    'NativeStackView', { state, descriptors }, descriptors[state.routes[state.index].key]?.render(),
) }));
vi.mock('expo-router', () => ({
    withLayoutContext: (component: any) => component,
    useRouter: () => ({ push: (href: string) => mocks.send(StackActions.push(href.slice(1))) }),
}));
vi.mock('@/components/AppStack', () => {
    const Stack = ({ children }: { children: React.ReactNode }) => children;
    Stack.Screen = ({ name, options }: { name: string; options: unknown }) => {
        mocks.screenOptions[name] = options;
        return null;
    };
    return { Stack };
});
vi.mock('@/components/CardStackScene', () => ({ CardStackScene: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('@/components/navigation/Header', () => ({ createHeader: () => null }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0', runtimeVersion: 'test' } } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: null }));
vi.mock('expo-updates', () => ({
    runtimeVersion: null,
    checkForUpdateAsync: vi.fn(),
    fetchUpdateAsync: vi.fn(),
    reloadAsync: vi.fn(),
}));
// Upgrade identity is covered separately; this desktop router harness has no Expo native host.
vi.mock('@/sync/nativeUpdate', () => ({ refreshNativeUpdateStatus: vi.fn(async () => ({ status: 'unsupported', available: false })) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: {} }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/hooks/useUnifiedAuthQrCode', () => ({ useUnifiedAuthQrCode: () => ({ connectAuthQrCode: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }) }));
vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [], useLocalSettingMutable: (key: string) => [key === 'themePreference' ? 'light' : false, vi.fn()],
    useLocalSetting: () => 'default',
    useProfile: () => ({ connectedServices: [] }), useSetting: (key: string) => key === 'preferredLanguage' ? 'en' : false,
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/serverConfig', () => ({ isUsingCustomServer: () => false }));
vi.mock('@/track', () => ({ trackWhatsNewClicked: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: mocks.confirm, prompt: vi.fn() } }));
vi.mock('@/hooks/useMultiClick', () => ({ useMultiClick: (callback: unknown) => callback }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => factory({ colors: {
        button: { primary: { background: '#00aaff', tint: '#000' } }, surfaceHigh: '#222',
        accent: '#00ff88', divider: '#333', surface: '#111', surfacePressed: '#222', surfaceSelected: '#333',
        text: '#fff', textLink: '#00aaff', textSecondary: '#aaa', header: { background: '#111', tint: '#fff' },
        shadow: { color: '#000' }, modal: { backdrop: 'rgba(0,0,0,.42)' }, status: { connected: '#0f0', connecting: '#ff0', disconnected: '#f00' },
    } }), absoluteFill: {}, hairlineWidth: 1 },
    useUnistyles: () => ({ theme: { colors: {
        button: { primary: { background: '#00aaff', tint: '#000' } }, surfaceHigh: '#222',
        accent: '#00ff88', divider: '#333', surface: '#111', surfacePressed: '#222', surfaceSelected: '#333',
        text: '#fff', textLink: '#00aaff', textSecondary: '#aaa', header: { background: '#111', tint: '#fff' },
        shadow: { color: '#000' }, modal: { backdrop: 'rgba(0,0,0,.42)' }, status: { connected: '#0f0', connecting: '#ff0', disconnected: '#f00' },
    } } }),
}));
vi.mock('@/hooks/useEnvironmentDashboard', () => ({ useEnvironmentDashboard: vi.fn() }));
vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => ({
    profiles: [], bindings: [], migration: 'none', loading: false, busy: false, error: null,
    rename: vi.fn(), remove: vi.fn(), bind: vi.fn(),
}) }));
vi.mock('@/hooks/useHappyAction', () => ({ useHappyAction: (action: unknown) => [false, action] }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/sync/apiGithub', () => ({ disconnectGitHub: vi.fn(), getGitHubOAuthParams: vi.fn() }));
vi.mock('@/sync/apiServices', () => ({ disconnectService: vi.fn() }));
vi.mock('@/sync/profile', () => ({ getDisplayName: () => null }));
vi.mock('@/components/MascotSwitcher', () => ({ MascotSwitcher: 'MascotSwitcher' }));
vi.mock('@/text', () => ({
    SUPPORTED_LANGUAGES: { en: {} }, getLanguageNativeName: () => 'English', getCurrentLanguage: () => 'en', t: (key: string, params?: { actions?: string }) => {
        if (key === 'deviceEnvironment.confirmMessage') return `GitHub authentication requires sign-in\n${params?.actions ?? ''}`;
        if (key === 'deviceEnvironment.confirmPawsMessage') return `npm global ownership is required\n${params?.actions ?? ''}`;
        return key;
    },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/components/settingsFeatureEntries', () => ({ getSettingsFeatureEntries: () => [] }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));

import RootLayout from '@/app/(app)/_layout';
import SettingsDeviceEnvironment from '@/app/(app)/settings/device-environment';
import { SettingsView } from './SettingsView';
import { DesktopStackNavigator } from './DesktopAppStack';

const options = {
    routeNames: ['index', 'session/[id]', 'settings/index', 'settings/device-environment'], routeParamList: {}, routeGetIdList: {},
};
const controller: EnvironmentDashboardController = {
    rows: [], scanning: false, running: false,
    scan: vi.fn(), update: vi.fn(), runSingle: vi.fn(), confirmStopped: vi.fn(), getCandidates: () => [],
};

function textContent(node: { findAllByType: (type: string) => Array<{ children: unknown[] }> }): string[] {
    return node.findAllByType('Text').map((textNode) => textNode.children.join(''));
}

describe('Device Environment desktop settings modal integration', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    let state: any;
    let router: ReturnType<typeof createDesktopModalRouter>;
    let original: ReturnType<typeof StackRouter>;
    let restoreModuleResolution: (() => void) | undefined;

    beforeAll(async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        const imageAssetMockPath = fileURLToPath(new URL('../../package.json', import.meta.url));
        const nodeModule = (await import('node:module')).default as unknown as {
            _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
        };
        const originalResolveFilename = nodeModule._resolveFilename;
        nodeModule._resolveFilename = (request, parent, isMain, resolveOptions) => request === '@/assets/images/icon-claude.png'
            ? imageAssetMockPath : originalResolveFilename(request, parent, isMain, resolveOptions);
        restoreModuleResolution = () => { nodeModule._resolveFilename = originalResolveFilename; };
    });

    afterAll(() => restoreModuleResolution?.());
    afterEach(() => act(() => renderer?.unmount()));

    it('opens the actual Device Environment settings entry in the modal, then returns to the workspace', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        mocks.screenOptions = {};
        let layoutRenderer: TestRenderer.ReactTestRenderer;
        act(() => { layoutRenderer = TestRenderer.create(<RootLayout />); });
        expect(mocks.screenOptions['settings/device-environment']).toMatchObject({
            headerTitle: 'deviceEnvironment.title', headerBackTitle: 'settings.title',
        });
        act(() => layoutRenderer!.unmount());

        original = StackRouter({ initialRouteName: 'index' });
        router = createDesktopModalRouter({ initialRouteName: 'index' });
        state = original.getInitialState(options);
        const send = (action: any) => { state = router.getStateForAction(state, action, options) ?? state; };
        const background = StackActions.push('session/[id]', { id: 'workspace' });
        send(background);
        const workspace = state.routes;
        send(StackActions.push('settings/index', { desktopModal: '1' }));

        const render = () => {
            mocks.state = state;
            mocks.descriptors = Object.fromEntries(state.routes.map((route: any) => [route.key, {
                route,
                options: mocks.screenOptions[route.name] ?? { headerTitle: route.name },
                render: () => route.name === 'settings/index'
                    ? <SettingsView />
                    : route.name === 'settings/device-environment'
                        ? React.createElement(SettingsDeviceEnvironment as any, { controller })
                        : React.createElement('Text', null, 'Workspace content'),
            }]));
            act(() => {
                if (renderer) renderer.update(<DesktopStackNavigator children={null} />);
                else renderer = TestRenderer.create(<DesktopStackNavigator children={null} />);
            });
        };
        mocks.send = (action: any) => { send(action); render(); };
        render();

        act(() => renderer!.root.findByProps({ testID: 'settings-device-environment' }).props.onPress());
        expect(renderer!.root.findByType('Modal').props.visible).toBe(true);
        const deviceEnvironmentPanel = renderer!.root.findByProps({ testID: 'desktop-modal-panel' });
        expect(textContent(deviceEnvironmentPanel)).toContain('deviceEnvironment.title');
        expect(deviceEnvironmentPanel.findByProps({ testID: 'environment-summary' })).toBeDefined();

        act(() => renderer!.root.findByProps({ testID: 'desktop-modal-back' }).props.onPress());
        const settingsPanel = renderer!.root.findByProps({ testID: 'desktop-modal-panel' });
        expect(textContent(settingsPanel)).toContain('settings.title');
        expect(renderer!.root.findByProps({ testID: 'settings-device-environment' })).toBeDefined();

        act(() => renderer!.root.findByProps({ testID: 'desktop-modal-close' }).props.onPress());
        expect(state.routes).toEqual(workspace);
        expect(renderer!.root.findByType('Modal').props.visible).toBe(false);
        expect(textContent(renderer!.root)).toContain('Workspace content');
    });

});

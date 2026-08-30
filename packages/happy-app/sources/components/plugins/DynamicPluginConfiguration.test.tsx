import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ install: vi.fn(), testConnection: vi.fn(), uninstall: vi.fn() }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory({ colors: {
        accent: '#00f', divider: '#ddd', input: { background: '#fff' },
        text: '#111', textDestructive: '#f00', textSecondary: '#666',
    } }) },
    useUnistyles: () => ({ theme: { colors: {
        accent: '#00f', textDestructive: '#f00', textSecondary: '#666',
    } } }),
}));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/hooks/useHappyAction', () => ({
    useHappyAction: (action: (...args: any[]) => Promise<void>) => [false, action],
}));
vi.mock('@/sync/plugins', () => ({
    installPlugin: mocks.install,
    testPluginConnection: mocks.testConnection,
    uninstallPlugin: mocks.uninstall,
}));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'zh-Hans', t: (key: string) => key }));

import { DynamicPluginConfiguration } from './DynamicPluginConfiguration';

const manifest = {
    schemaVersion: 2 as const,
    hostApiVersion: 1 as const,
    id: 'server-plugin',
    version: '2.3.0',
    title: { default: 'Server plugin' },
    description: { default: 'Dynamic' },
    icon: 'apps-outline',
    featured: true,
    installedAction: 'configure' as const,
    permissions: ['paws.secrets.use' as const, 'paws.storage.images.write' as const],
    entrypoint: { type: 'view' as const, viewId: 'server-plugin.page' },
    contributes: {
        views: [{ id: 'server-plugin.page', surface: 'page' as const, title: { default: 'Server plugin' } }],
    },
    configuration: {
        notice: { default: 'Encrypted', translations: { 'zh-Hans': '加密保存' } },
        fields: [
            {
                key: 'token', type: 'secret' as const, required: true,
                label: { default: 'Token', translations: { 'zh-Hans': '令牌' } },
            },
            {
                key: 'endpoint', type: 'url' as const, required: true,
                label: { default: 'Endpoint' }, placeholder: { default: 'https://example.com' },
            },
        ],
    },
};

describe('DynamicPluginConfiguration', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.install.mockResolvedValue({ installed: true });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('builds localized fields from the manifest and pins its version on install', async () => {
        const installedStatus = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: [...manifest.permissions],
            configuration: { endpoint: 'https://example.com/v1' },
            secretHints: { token: 'cret' },
        };
        mocks.install.mockResolvedValue(installedStatus);
        const onInstalled = vi.fn();
        const onStatusChanged = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onInstalled={onInstalled}
                onStatusChanged={onStatusChanged}
                plugin={{ manifest, status: { installed: false } }}
            />);
        });
        const fields = renderer.root.findAllByType('TextInput');
        expect(fields[0].props.accessibilityLabel).toBe('令牌');

        act(() => {
            fields[0].props.onChangeText('server-secret');
            fields[1].props.onChangeText('https://example.com/v1');
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'server-plugin-plugin-install' }).props.onPress();
        });

        expect(mocks.install).toHaveBeenCalledWith(
            'server-plugin',
            '2.3.0',
            { token: 'server-secret', endpoint: 'https://example.com/v1' },
            ['paws.secrets.use', 'paws.storage.images.write'],
        );
        expect(renderer.root.findByProps({
            title: 'relationshipAdvisorPlugin.permissions',
        }).props.footer).toBe('relationshipAdvisorPlugin.permissionGrantNotice');
        expect(renderer.root.findByProps({
            testID: 'server-plugin-permission-paws.secrets.use',
        }).props.title).toBe('relationshipAdvisorPlugin.permissionSecretsUse');
        expect(renderer.root.findByProps({
            testID: 'server-plugin-built-in-code',
        }).props.subtitle).toBe('relationshipAdvisorPlugin.builtInCodeNotice');
        expect(onStatusChanged).toHaveBeenCalledTimes(1);
        expect(onInstalled).toHaveBeenCalledWith(installedStatus);
        act(() => renderer.unmount());
    });

    it('shows only the stored secret hint when reconfiguring', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest,
                status: {
                    installed: true,
                    version: '2.3.0',
                    grantedPermissions: [...manifest.permissions],
                    configuration: { endpoint: 'https://example.com/v1' },
                    secretHints: { token: '1234' },
                },
            }} />);
        });

        const token = renderer.root.findAllByType('TextInput')[0];
        expect(token.props.value).toBe('');
        expect(token.props.placeholder).toContain('1234');
        act(() => renderer.unmount());
    });

    it('lets the user reveal and conceal only the newly entered secret', async () => {
        const installedStatus = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: [...manifest.permissions],
            configuration: { endpoint: 'https://example.com/v1' },
            secretHints: { token: '1234' },
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest,
                status: installedStatus,
            }} />);
        });

        const token = renderer.root.findAllByType('TextInput')[0];
        let visibilityToggle = renderer.root.findByProps({
            testID: 'server-plugin-plugin-token-visibility-toggle',
        });
        expect(token.props.secureTextEntry).toBe(true);
        expect(token.props.value).toBe('');
        expect(visibilityToggle.props.disabled).toBe(true);
        expect(visibilityToggle.props.accessibilityState).toEqual({ disabled: true });
        expect(visibilityToggle.props.accessibilityLabel)
            .toContain('relationshipAdvisorPlugin.encryptionNotice');

        act(() => token.props.onChangeText('replacement-secret'));
        expect(renderer.root.findAllByType('TextInput')[0].props.value)
            .toBe('replacement-secret');
        visibilityToggle = renderer.root.findByProps({
            testID: 'server-plugin-plugin-token-visibility-toggle',
        });
        expect(visibilityToggle.props.disabled).toBe(false);

        act(() => visibilityToggle.props.onPress());
        expect(renderer.root.findAllByType('TextInput')[0].props.secureTextEntry)
            .toBe(false);
        expect(renderer.root.findByProps({ testID: 'server-plugin-plugin-token-visibility-toggle' })
            .props.accessibilityLabel).toContain('settingsAccount.tapToHide');

        await act(async () => {
            renderer.update(<DynamicPluginConfiguration plugin={{
                manifest,
                status: { ...installedStatus },
            }} />);
        });
        const refreshedToken = renderer.root.findAllByType('TextInput')[0];
        const refreshedToggle = renderer.root.findByProps({
            testID: 'server-plugin-plugin-token-visibility-toggle',
        });
        expect(refreshedToken.props.value).toBe('');
        expect(refreshedToken.props.secureTextEntry).toBe(true);
        expect(refreshedToggle.props.disabled).toBe(true);

        act(() => refreshedToken.props.onChangeText('another-replacement'));
        expect(renderer.root.findAllByType('TextInput')[0].props.secureTextEntry)
            .toBe(true);
        act(() => renderer.unmount());
    });

    it('validates provider configuration before it is saved', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...manifest, permissions: ['paws.ai.provider.invoke'] },
                status: { installed: false },
            }} />);
        });

        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('server-secret');
            fields[1].props.onChangeText('https://example.com/v1');
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'server-plugin-plugin-test-connection' }).props.onPress();
        });

        expect(mocks.testConnection).toHaveBeenCalledWith(
            'server-plugin',
            '2.3.0',
            { token: 'server-secret', endpoint: 'https://example.com/v1' },
            ['paws.ai.provider.invoke'],
        );
        expect(renderer.root.findByProps({ testID: 'server-plugin-plugin-test-connection-result' }).props.title)
            .toBe('relationshipAdvisorPlugin.connectionSuccess');
        expect(mocks.install).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('does not show a stale connection result after configuration changes', async () => {
        let resolveConnection: ((value: { success: true; latencyMs: number }) => void) | undefined;
        mocks.testConnection.mockReturnValue(new Promise((resolve) => {
            resolveConnection = resolve;
        }));
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...manifest, permissions: ['paws.ai.provider.invoke'] },
                status: { installed: false },
            }} />);
        });

        let fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('server-secret');
            fields[1].props.onChangeText('https://example.com/v1');
        });
        let pendingTest: Promise<void> | undefined;
        act(() => {
            pendingTest = renderer.root.findByProps({
                testID: 'server-plugin-plugin-test-connection',
            }).props.onPress();
        });
        fields = renderer.root.findAllByType('TextInput');
        act(() => fields[1].props.onChangeText('https://example.com/v2'));
        await act(async () => {
            resolveConnection?.({ success: true, latencyMs: 31 });
            await pendingTest;
        });

        expect(renderer.root.findAllByProps({
            testID: 'server-plugin-plugin-test-connection-result',
        })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('requires an explicit update before opening when stored permission grants are incomplete', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...manifest, installedAction: 'open' },
                status: {
                    installed: true,
                    version: '2.3.0',
                    grantedPermissions: [],
                    configuration: { endpoint: 'https://example.com/v1' },
                    secretHints: { token: '1234' },
                },
            }} />);
        });

        expect(renderer.root.findAllByProps({ testID: 'server-plugin-plugin-open' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'server-plugin-plugin-status' }).props).toMatchObject({
            title: 'relationshipAdvisorPlugin.reviewRequired',
            subtitle: 'relationshipAdvisorPlugin.reviewRequiredSubtitle',
        });
        expect(renderer.root.findByProps({ testID: 'server-plugin-plugin-install' }).props.title)
            .toBe('relationshipAdvisorPlugin.reviewAndUpdate');
        act(() => renderer.unmount());
    });
});

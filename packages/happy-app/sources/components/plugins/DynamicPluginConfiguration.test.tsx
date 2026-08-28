import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ install: vi.fn(), uninstall: vi.fn() }));
vi.mock('react-native', () => ({ Text: 'Text', TextInput: 'TextInput', View: 'View' }));
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
vi.mock('@/sync/plugins', () => ({ installPlugin: mocks.install, uninstallPlugin: mocks.uninstall }));
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
    permissions: [],
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
        const onStatusChanged = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
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

        expect(mocks.install).toHaveBeenCalledWith('server-plugin', '2.3.0', {
            token: 'server-secret', endpoint: 'https://example.com/v1',
        });
        expect(onStatusChanged).toHaveBeenCalledTimes(1);
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
                    configuration: { endpoint: 'https://example.com/v1' },
                    secretHints: { token: '1234' },
                },
            }} />);
        });

        const token = renderer.root.findByProps({ testID: 'server-plugin-plugin-token' });
        expect(token.props.value).toBe('');
        expect(token.props.placeholder).toContain('1234');
        act(() => renderer.unmount());
    });
});

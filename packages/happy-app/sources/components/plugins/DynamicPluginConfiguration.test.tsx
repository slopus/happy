import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => {
    const drafts = new Map<string, Record<string, string>>();
    const draftKey = (pluginId: string, pluginVersion: string) => `${pluginId}@${pluginVersion}`;
    let draftScope = 0;
    return {
        drafts,
        advanceDraftScope: () => {
            draftScope += 1;
            drafts.clear();
        },
        install: vi.fn(),
        resetDraftScope: () => {
            draftScope = 0;
        },
        testConnection: vi.fn(),
        uninstall: vi.fn(),
        sync: {
            clearPluginConfigurationDraft: vi.fn((
                pluginId: string,
                pluginVersion: string,
                expectedDraft?: Record<string, string>,
                scope = draftScope,
            ) => {
                if (scope !== draftScope) return;
                const key = draftKey(pluginId, pluginVersion);
                if (expectedDraft && JSON.stringify(drafts.get(key)) !== JSON.stringify(expectedDraft)) return;
                drafts.delete(key);
            }),
            getPluginConfigurationDraft: vi.fn((
                pluginId: string,
                pluginVersion: string,
                scope = draftScope,
            ) => scope === draftScope ? drafts.get(draftKey(pluginId, pluginVersion)) : undefined),
            getPluginConfigurationDraftScope: vi.fn(() => draftScope),
            isPluginConfigurationDraftScopeCurrent: vi.fn((scope: number) => scope === draftScope),
            setPluginConfigurationDraft: vi.fn((
                pluginId: string,
                pluginVersion: string,
                draft: Record<string, string>,
                scope = draftScope,
            ) => {
                if (scope !== draftScope) return;
                const key = draftKey(pluginId, pluginVersion);
                if (Object.keys(draft).length === 0) {
                    drafts.delete(key);
                    return;
                }
                drafts.set(key, { ...draft });
            }),
        },
    };
});
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
vi.mock('@/hooks/useHappyAction', async () => {
    const ReactModule = await import('react');
    return {
        useHappyAction: (action: (...args: any[]) => Promise<void>) => {
            const [running, setRunning] = ReactModule.useState(false);
            const perform = ReactModule.useCallback(async () => {
                if (running) return;
                setRunning(true);
                try {
                    await action();
                } finally {
                    setRunning(false);
                }
            }, [action, running]);
            return [running, perform] as const;
        },
    };
});
vi.mock('@/sync/plugins', () => ({
    installPlugin: mocks.install,
    testPluginConnection: mocks.testConnection,
    uninstallPlugin: mocks.uninstall,
}));
vi.mock('@/sync/sync', () => ({ sync: mocks.sync }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'zh-Hans',
    t: (key: string) => ({
        'relationshipAdvisorPlugin.apiKeyPlaceholder': '例如：sk-...',
        'relationshipAdvisorPlugin.baseUrlPlaceholder': '例如：https://api.deepseek.com',
        'relationshipAdvisorPlugin.modelPlaceholder': '例如：deepseek-v4-flash-vision-exp',
        'relationshipAdvisorPlugin.modelRecommendation': '建议填写支持多模态的模型，才能同时理解文字和图片。',
    }[key] ?? key),
}));

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

const relationshipAdvisorManifest = {
    ...manifest,
    id: 'relationship-advisor',
    permissions: ['paws.ai.provider.invoke' as const, 'paws.secrets.use' as const],
    configuration: {
        fields: [
            {
                key: 'apiKey', type: 'secret' as const, required: true,
                label: { default: 'API key' }, placeholder: { default: 'Enter API key' },
            },
            {
                key: 'baseUrl', type: 'url' as const, required: true,
                label: { default: 'Provider URL' }, placeholder: { default: 'https://api.openai.com/v1' },
            },
            {
                key: 'model', type: 'text' as const, required: true,
                label: { default: 'Model' }, placeholder: { default: 'gpt-4.1-mini' },
            },
        ],
    },
};

describe('DynamicPluginConfiguration', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.drafts.clear();
        mocks.resetDraftScope();
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

    it('saves provider configuration after a successful connection test', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        mocks.install.mockResolvedValue({
            installed: true,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke'],
            configuration: { endpoint: 'https://example.com/v1' },
            secretHints: { token: 'cret' },
        });
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
        expect(mocks.install).toHaveBeenCalledWith(
            'server-plugin',
            '2.3.0',
            { token: 'server-secret', endpoint: 'https://example.com/v1' },
            ['paws.ai.provider.invoke'],
        );
        act(() => renderer.unmount());
    });

    it('does not run the explicit-install navigation callback after an automatic test save', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        mocks.install.mockResolvedValue({
            installed: true,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke'],
            configuration: { endpoint: 'https://example.com/v1' },
            secretHints: { token: 'cret' },
        });
        const onInstalled = vi.fn();
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onInstalled={onInstalled}
                plugin={{
                    manifest: { ...manifest, id: 'automatic-save-plugin', permissions: ['paws.ai.provider.invoke'] },
                    status: { installed: false },
                }}
            />);
        });

        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('server-secret');
            fields[1].props.onChangeText('https://example.com/v1');
        });
        await act(async () => {
            await renderer.root.findByProps({
                testID: 'automatic-save-plugin-plugin-test-connection',
            }).props.onPress();
        });

        expect(mocks.install).toHaveBeenCalledOnce();
        expect(onInstalled).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('keeps the successful connection result visible after the saved status refreshes', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        const initialStatus = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke' as const],
            configuration: { endpoint: 'https://example.com/saved' },
            secretHints: { token: '1234' },
        };
        const updatedStatus = {
            ...initialStatus,
            configuration: { endpoint: 'https://example.com/draft' },
        };
        mocks.install.mockResolvedValue(updatedStatus);
        const refreshManifest = {
            ...manifest,
            id: 'refresh-result-plugin',
            permissions: ['paws.ai.provider.invoke' as const],
        };
        let renderer: any;
        const onStatusChanged = async () => {
            renderer.update(<DynamicPluginConfiguration
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: refreshManifest, status: updatedStatus }}
            />);
        };
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: refreshManifest, status: initialStatus }}
            />);
        });

        act(() => renderer.root.findAllByType('TextInput')[1].props.onChangeText('https://example.com/draft'));
        await act(async () => {
            await renderer.root.findByProps({
                testID: 'refresh-result-plugin-plugin-test-connection',
            }).props.onPress();
        });

        expect(renderer.root.findByProps({
            testID: 'refresh-result-plugin-plugin-test-connection-result',
        }).props.title).toBe('relationshipAdvisorPlugin.connectionSuccess');
        act(() => renderer.unmount());
    });

    it('keeps a failed connection test as an unsaved draft', async () => {
        mocks.testConnection.mockResolvedValue({ success: false, code: 'authentication_failed' });
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...manifest, id: 'failed-test-plugin', permissions: ['paws.ai.provider.invoke'] },
                status: { installed: false },
            }} />);
        });

        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('bad-secret');
            fields[1].props.onChangeText('https://example.com/v1');
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'failed-test-plugin-plugin-test-connection' }).props.onPress();
        });

        expect(mocks.install).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({
            testID: 'failed-test-plugin-plugin-unsaved-changes',
        }).props.subtitle).toBe('relationshipAdvisorPlugin.unsavedChangesSubtitle');
        act(() => renderer.unmount());
    });

    it('retains an unsaved URL after the configuration surface remounts', async () => {
        const draftManifest = { ...manifest, id: 'tab-draft-plugin' };
        const status = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: [...manifest.permissions],
            configuration: { endpoint: 'https://example.com/saved' },
            secretHints: { token: '1234' },
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{ manifest: draftManifest, status }} />);
        });

        act(() => {
            renderer.root.findAllByType('TextInput')[0].props.onChangeText('unsaved-secret');
            renderer.root.findAllByType('TextInput')[1].props.onChangeText('https://example.com/draft');
        });
        expect(mocks.drafts.get('tab-draft-plugin@2.3.0')).toEqual({
            endpoint: 'https://example.com/draft',
        });
        act(() => renderer.unmount());
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: draftManifest,
                status: { ...status, configuration: { ...status.configuration } },
            }} />);
        });

        expect(renderer.root.findAllByType('TextInput')[0].props.value).toBe('');
        expect(renderer.root.findAllByType('TextInput')[1].props.value).toBe('https://example.com/draft');
        expect(renderer.root.findByProps({
            testID: 'tab-draft-plugin-plugin-unsaved-changes',
        }).props.subtitle).toBe('relationshipAdvisorPlugin.unsavedChangesSubtitle');
        act(() => renderer.unmount());
    });

    it('does not reuse an unsaved draft after the plugin version changes', async () => {
        const draftManifest = { ...manifest, id: 'version-scoped-draft-plugin' };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: draftManifest,
                status: { installed: false },
            }} />);
        });

        act(() => renderer.root.findAllByType('TextInput')[1].props.onChangeText('https://example.com/draft'));
        act(() => renderer.unmount());
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...draftManifest, version: '3.0.0' },
                status: { installed: false },
            }} />);
        });

        expect(renderer.root.findAllByType('TextInput')[1].props.value).toBe('');
        act(() => renderer.unmount());
    });

    it('retires the submitted draft when a save finishes after the surface unmounts', async () => {
        let resolveInstall: ((value: {
            installed: true;
            version: string;
            grantedPermissions: typeof manifest.permissions;
            configuration: { endpoint: string };
            secretHints: { token: string };
        }) => void) | undefined;
        mocks.install.mockReturnValue(new Promise((resolve) => {
            resolveInstall = resolve;
        }));
        const saveManifest = { ...manifest, id: 'unmounted-save-plugin' };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: saveManifest,
                status: { installed: false },
            }} />);
        });
        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('server-secret');
            fields[1].props.onChangeText('https://example.com/submitted');
        });

        let pendingSave: Promise<void> | undefined;
        act(() => {
            pendingSave = renderer.root.findByProps({
                testID: 'unmounted-save-plugin-plugin-install',
            }).props.onPress();
            renderer.unmount();
        });
        await act(async () => {
            resolveInstall?.({
                installed: true,
                version: '2.3.0',
                grantedPermissions: [...manifest.permissions],
                configuration: { endpoint: 'https://example.com/submitted' },
                secretHints: { token: 'cret' },
            });
            await pendingSave;
        });
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: saveManifest,
                status: { installed: false },
            }} />);
        });

        expect(renderer.root.findAllByType('TextInput')[1].props.value).toBe('');
        act(() => renderer.unmount());
    });

    it('clears successful connection feedback after uninstall or an incompatible catalog update', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        const installedStatus = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke' as const],
            configuration: { endpoint: 'https://example.com/saved' },
            secretHints: { token: '1234' },
        };
        const testedStatus = {
            ...installedStatus,
            configuration: { endpoint: 'https://example.com/tested' },
        };
        mocks.install.mockResolvedValue(testedStatus);
        const feedbackManifest = {
            ...manifest,
            id: 'feedback-lifecycle-plugin',
            permissions: ['paws.ai.provider.invoke' as const],
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: feedbackManifest,
                status: installedStatus,
            }} />);
        });
        act(() => renderer.root.findAllByType('TextInput')[1].props.onChangeText('https://example.com/tested'));
        await act(async () => {
            await renderer.root.findByProps({
                testID: 'feedback-lifecycle-plugin-plugin-test-connection',
            }).props.onPress();
        });
        expect(renderer.root.findAllByProps({
            testID: 'feedback-lifecycle-plugin-plugin-test-connection-result',
        })).toHaveLength(1);

        await act(async () => {
            renderer.update(<DynamicPluginConfiguration plugin={{
                manifest: feedbackManifest,
                status: { ...testedStatus, secretHints: { token: 'changed' } },
            }} />);
        });
        expect(renderer.root.findAllByProps({
            testID: 'feedback-lifecycle-plugin-plugin-test-connection-result',
        })).toHaveLength(0);

        await act(async () => {
            renderer.update(<DynamicPluginConfiguration plugin={{
                manifest: feedbackManifest,
                status: testedStatus,
            }} />);
        });
        await act(async () => {
            renderer.update(<DynamicPluginConfiguration plugin={{
                manifest: feedbackManifest,
                status: { ...testedStatus, configuration: { endpoint: 'https://example.com/external' } },
            }} />);
        });
        expect(renderer.root.findAllByProps({
            testID: 'feedback-lifecycle-plugin-plugin-test-connection-result',
        })).toHaveLength(0);

        await act(async () => {
            renderer.update(<DynamicPluginConfiguration plugin={{
                manifest: feedbackManifest,
                status: { installed: false },
            }} />);
        });
        expect(renderer.root.findAllByProps({
            testID: 'feedback-lifecycle-plugin-plugin-test-connection-result',
        })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('does not publish stale success feedback when the catalog changes during the save refresh', async () => {
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 31 });
        const initialStatus = {
            installed: true as const,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke' as const],
            configuration: { endpoint: 'https://example.com/saved' },
            secretHints: { token: '1234' },
        };
        const savedStatus = {
            ...initialStatus,
            configuration: { endpoint: 'https://example.com/tested' },
            secretHints: { token: 'tested' },
        };
        const externalStatus = {
            ...savedStatus,
            configuration: { endpoint: 'https://example.com/external' },
            secretHints: { token: 'external' },
        };
        mocks.install.mockResolvedValue(savedStatus);
        const raceManifest = {
            ...manifest,
            id: 'feedback-save-race-plugin',
            permissions: ['paws.ai.provider.invoke' as const],
        };
        let renderer: any;
        const onStatusChanged = async () => {
            renderer.update(<DynamicPluginConfiguration
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: raceManifest, status: externalStatus }}
            />);
        };
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: raceManifest, status: initialStatus }}
            />);
        });
        act(() => renderer.root.findAllByType('TextInput')[1].props.onChangeText('https://example.com/tested'));
        await act(async () => {
            await renderer.root.findByProps({
                testID: 'feedback-save-race-plugin-plugin-test-connection',
            }).props.onPress();
        });

        expect(renderer.root.findAllByProps({
            testID: 'feedback-save-race-plugin-plugin-test-connection-result',
        })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('locks every configuration field while a save request is pending', async () => {
        let resolveInstall: ((value: {
            installed: true;
            version: string;
            grantedPermissions: typeof manifest.permissions;
            configuration: { endpoint: string };
            secretHints: { token: string };
        }) => void) | undefined;
        mocks.install.mockReturnValue(new Promise((resolve) => {
            resolveInstall = resolve;
        }));
        const lockedManifest = { ...manifest, id: 'locked-during-save-plugin' };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: lockedManifest,
                status: { installed: false },
            }} />);
        });
        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('submitted-secret');
            fields[1].props.onChangeText('https://example.com/submitted');
        });
        let pendingSave: Promise<void> | undefined;
        await act(async () => {
            pendingSave = renderer.root.findByProps({
                testID: 'locked-during-save-plugin-plugin-install',
            }).props.onPress();
            await Promise.resolve();
        });

        expect(renderer.root.findAllByType('TextInput').every((field: any) => field.props.editable === false))
            .toBe(true);

        await act(async () => {
            resolveInstall?.({
                installed: true,
                version: '2.3.0',
                grantedPermissions: [...manifest.permissions],
                configuration: { endpoint: 'https://example.com/submitted' },
                secretHints: { token: 'cret' },
            });
            await pendingSave;
        });
        act(() => renderer.unmount());
    });

    it('does not run the old account install callback after account scope changes during refresh', async () => {
        let finishRefresh: (() => void) | undefined;
        const onStatusChanged = vi.fn(() => new Promise<void>((resolve) => {
            finishRefresh = resolve;
        }));
        const onInstalled = vi.fn();
        mocks.install.mockResolvedValue({
            installed: true,
            version: '2.3.0',
            grantedPermissions: [...manifest.permissions],
            configuration: { endpoint: 'https://example.com/account-a' },
            secretHints: { token: 'cret' },
        });
        const scopedManifest = { ...manifest, id: 'account-scope-install-plugin' };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onInstalled={onInstalled}
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: scopedManifest, status: { installed: false } }}
            />);
        });
        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('account-a-secret');
            fields[1].props.onChangeText('https://example.com/account-a');
        });
        let pendingInstall: Promise<void> | undefined;
        await act(async () => {
            pendingInstall = renderer.root.findByProps({
                testID: 'account-scope-install-plugin-plugin-install',
            }).props.onPress();
            await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledTimes(1));
        });

        mocks.advanceDraftScope();
        await act(async () => {
            finishRefresh?.();
            await pendingInstall;
        });

        expect(onInstalled).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('does not publish automatic-test success after account scope changes during refresh', async () => {
        let finishRefresh: (() => void) | undefined;
        const onStatusChanged = vi.fn(() => new Promise<void>((resolve) => {
            finishRefresh = resolve;
        }));
        mocks.testConnection.mockResolvedValue({ success: true, latencyMs: 21 });
        mocks.install.mockResolvedValue({
            installed: true,
            version: '2.3.0',
            grantedPermissions: ['paws.ai.provider.invoke'],
            configuration: { endpoint: 'https://example.com/account-a' },
            secretHints: { token: 'cret' },
        });
        const scopedManifest = {
            ...manifest,
            id: 'account-scope-test-plugin',
            permissions: ['paws.ai.provider.invoke' as const],
        };
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration
                onStatusChanged={onStatusChanged}
                plugin={{ manifest: scopedManifest, status: { installed: false } }}
            />);
        });
        const fields = renderer.root.findAllByType('TextInput');
        act(() => {
            fields[0].props.onChangeText('account-a-secret');
            fields[1].props.onChangeText('https://example.com/account-a');
        });
        let pendingTest: Promise<void> | undefined;
        await act(async () => {
            pendingTest = renderer.root.findByProps({
                testID: 'account-scope-test-plugin-plugin-test-connection',
            }).props.onPress();
            await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledTimes(1));
        });

        mocks.advanceDraftScope();
        await act(async () => {
            finishRefresh?.();
            await pendingTest;
        });

        expect(renderer.root.findAllByProps({
            testID: 'account-scope-test-plugin-plugin-test-connection-result',
        })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps configuration actions above permissions and status', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: { ...manifest, id: 'action-order-plugin', permissions: ['paws.ai.provider.invoke'] },
                status: { installed: false },
            }} />);
        });

        const orderedSections = renderer.root.findAll((node: any) => [
            'action-order-plugin-plugin-actions',
            'action-order-plugin-plugin-permissions',
            'action-order-plugin-plugin-status-section',
        ].includes(node.props.testID)).map((node: any) => node.props.testID);
        expect(orderedSections).toEqual([
            'action-order-plugin-plugin-actions',
            'action-order-plugin-plugin-permissions',
            'action-order-plugin-plugin-status-section',
        ]);
        act(() => renderer.unmount());
    });

    it('shows DeepSeek examples as placeholders and recommends a multimodal model', async () => {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<DynamicPluginConfiguration plugin={{
                manifest: relationshipAdvisorManifest,
                status: { installed: false },
            }} />);
        });

        const fields = renderer.root.findAllByType('TextInput');
        expect(fields.map((field: any) => field.props.placeholder)).toEqual([
            '例如：sk-...',
            '例如：https://api.deepseek.com',
            '例如：deepseek-v4-flash-vision-exp',
        ]);
        expect(renderer.root.findByProps({
            testID: 'relationship-advisor-plugin-model-recommendation',
        }).props.children).toBe('建议填写支持多模态的模型，才能同时理解文字和图片。');
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

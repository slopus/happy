import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer does not publish declarations used by this narrow test.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    refresh: vi.fn(),
    plugins: [] as any[],
}));

const manifest = (id: string, installedAction: 'configure' | 'open') => ({
    schemaVersion: 2,
    hostApiVersion: 1,
    id,
    version: '1.0.0',
    title: { default: id },
    description: { default: `${id} description` },
    icon: 'apps-outline',
    featured: true,
    installedAction,
    permissions: id === 'relationship-advisor'
        ? ['paws.ai.provider.invoke', 'paws.secrets.use']
        : id === 'generated-images-gallery'
            ? ['paws.conversations.images.read']
            : [],
    entrypoint: { type: 'view', viewId: id === 'relationship-advisor'
        ? 'relationship-advisor.chat'
        : id === 'generated-images-gallery'
            ? 'generated-images-gallery.browser'
            : `${id}.page` },
    contributes: {
        views: [
            {
                id: id === 'relationship-advisor'
                    ? 'relationship-advisor.chat'
                    : id === 'generated-images-gallery'
                        ? 'generated-images-gallery.browser'
                        : `${id}.page`,
                surface: 'page',
                title: { default: id },
            },
            ...(id === 'generated-images-gallery' ? [] : [{
                id: id === 'relationship-advisor'
                    ? 'relationship-advisor.configuration'
                    : `${id}.configuration`,
                surface: 'modal',
                title: { default: `${id} configuration` },
            }]),
        ],
    },
    configuration: { fields: [] },
});

function setPlugins(advisorInstalled = false, galleryInstalled = false) {
    mocks.plugins = [
        {
            manifest: manifest('relationship-advisor', 'configure'),
            status: advisorInstalled
                ? { installed: true, version: '1.0.0', configuration: {}, secretHints: {} }
                : { installed: false },
        },
        {
            manifest: manifest('generated-images-gallery', 'open'),
            status: galleryInstalled
                ? { installed: true, version: '1.0.0', configuration: {}, secretHints: {} }
                : { installed: false },
        },
    ];
}

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            accent: '#00f', divider: '#ddd', input: { background: '#fff' },
            shadow: { color: '#000', opacity: 0.2 }, surface: '#fff', surfacePressed: '#eee',
            surfaceSelected: '#ddd', text: '#111', textSecondary: '#666',
        },
    };
    return {
        StyleSheet: {
            absoluteFill: {},
            hairlineWidth: 1,
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/hooks/usePlugins', () => ({
    usePlugins: () => ({ loading: false, plugins: mocks.plugins, refresh: mocks.refresh }),
}));
vi.mock('./DynamicPluginConfiguration', () => ({
    DynamicPluginConfiguration: 'DynamicPluginConfiguration',
}));
vi.mock('./PluginModalSlot', () => ({ PluginModalSlot: 'PluginModalSlot' }));

import { PluginMarketplaceModal } from './PluginMarketplaceModal';

describe('PluginMarketplaceModal', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        setPlugins();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('opens an installable plugin from the featured catalog', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<PluginMarketplaceModal visible onClose={vi.fn()} />);
        });

        expect(renderer.root.findByProps({ testID: 'plugin-marketplace-featured-section' })).toBeTruthy();
        act(() => renderer.root.findByProps({ testID: 'plugin-marketplace-plugin-relationship-advisor' }).props.onPress());

        expect(renderer.root.findAllByType('DynamicPluginConfiguration')).toHaveLength(1);
        expect(renderer.root.findByType('DynamicPluginConfiguration').props.plugin.manifest.id)
            .toBe('relationship-advisor');
        expect(renderer.root.findByProps({ testID: 'plugin-marketplace-back' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('shows installed plugins separately and activates their declared modal contribution', () => {
        setPlugins(true, false);
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PluginMarketplaceModal
                    initialPluginId="relationship-advisor"
                    visible
                    onClose={vi.fn()}
                />,
            );
        });

        expect(renderer.root.findAllByType('PluginModalSlot')).toHaveLength(1);
        expect(renderer.root.findAllByType('DynamicPluginConfiguration')).toHaveLength(0);
        act(() => renderer.root.findByProps({ testID: 'plugin-marketplace-back' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'plugin-marketplace-installed-section' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('filters the catalog and renders an empty state', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<PluginMarketplaceModal visible onClose={vi.fn()} />);
        });

        act(() => renderer.root.findByProps({ testID: 'plugin-marketplace-search' }).props.onChangeText('missing'));

        expect(renderer.root.findByProps({ testID: 'plugin-marketplace-empty' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'plugin-marketplace-plugin-relationship-advisor' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('renders a newly returned server plugin without a bundled catalog change', () => {
        mocks.plugins.push({
            manifest: manifest('server-added-plugin', 'configure'),
            status: { installed: false },
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<PluginMarketplaceModal visible onClose={vi.fn()} />);
        });

        expect(renderer.root.findByProps({
            testID: 'plugin-marketplace-plugin-server-added-plugin',
        })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('falls back to host configuration when an installed plugin has no trusted modal adapter', () => {
        mocks.plugins.push({
            manifest: manifest('server-added-plugin', 'configure'),
            status: { installed: true, version: '1.0.0', configuration: {}, secretHints: {} },
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <PluginMarketplaceModal
                    initialPluginId="server-added-plugin"
                    visible
                    onClose={vi.fn()}
                />,
            );
        });

        expect(renderer.root.findAllByType('PluginModalSlot')).toHaveLength(0);
        expect(renderer.root.findByType('DynamicPluginConfiguration').props.plugin.manifest.id)
            .toBe('server-added-plugin');
        act(() => renderer.unmount());
    });

    it('opens the generated image gallery plugin and includes it in installed plugins', () => {
        setPlugins(false, true);
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<PluginMarketplaceModal visible onClose={vi.fn()} />);
        });

        expect(renderer.root.findByProps({
            testID: 'plugin-marketplace-plugin-generated-images-gallery',
        })).toBeTruthy();
        expect(renderer.root.findByProps({
            testID: 'plugin-marketplace-installed-generated-images-gallery',
        })).toBeTruthy();

        act(() => renderer.root.findByProps({
            testID: 'plugin-marketplace-plugin-generated-images-gallery',
        }).props.onPress());
        expect(renderer.root.findAllByType('DynamicPluginConfiguration')).toHaveLength(1);
        expect(renderer.root.findByType('DynamicPluginConfiguration').props.plugin.manifest.id)
            .toBe('generated-images-gallery');
        act(() => renderer.unmount());
    });
});

import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no declarations for the repo's test renderer
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn(), external: vi.fn(), alert: vi.fn(), plugins: [] as any[] }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push, navigate: mocks.navigate }) }));
vi.mock('@/hooks/usePlugins', () => ({ usePlugins: () => ({ plugins: mocks.plugins }) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: mocks.external }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./plugins/PluginMarketplaceModal', () => ({ PluginMarketplaceModal: 'PluginMarketplaceModal' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (fn: any) => fn({ colors: { textLink: 'link', textSecondary: 'secondary' } }) }, useUnistyles: () => ({ theme: { colors: { textLink: 'link', textSecondary: 'secondary' } } }) }));
import { ComposerReferenceChips } from './ComposerReferenceChips';
describe('actionable reference chips', () => {
    beforeEach(() => { vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.plugins = []; });
    const render = (references: any[], remove = vi.fn()) => { let renderer: any; act(() => { renderer = TestRenderer.create(<ComposerReferenceChips references={references} onRemove={remove} />); }); return renderer; };
    it('opens the exact selected session and supports removing it', () => {
        const ref = { kind: 'session', id: 'source', title: 'Earlier' };const remove = vi.fn();const tree = render([ref], remove);
        act(() => tree.root.findByProps({ accessibilityRole: 'link' }).props.onPress());
        expect(mocks.push).toHaveBeenCalledWith('/session/source');
        act(() => tree.root.findByProps({ accessibilityRole: 'button' }).props.onPress());
        expect(remove).toHaveBeenCalledWith(ref);act(() => tree.unmount());
    });
    it('opens the actual installed plugin entry through the existing trusted adapter', () => {
        mocks.plugins = [{ manifest: { id: 'generated-images-gallery', version: '1.0.0', icon: 'images-outline', permissions: ['paws.conversations.images.read'], entrypoint: { type: 'view', viewId: 'generated-images-gallery.browser' }, contributes: { views: [{ id: 'generated-images-gallery.browser', surface: 'page' }] } }, status: { installed: true, version: '1.0.0', grantedPermissions: ['paws.conversations.images.read'] } }];
        const tree = render([{ kind: 'plugin', id: 'generated-images-gallery', title: 'Images' }]);
        act(() => tree.root.findByProps({ accessibilityRole: 'link' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('/generated-images');act(() => tree.unmount());
    });
    it('opens a selected website and reports an uninstalled plugin instead of pretending to invoke it', () => {
        const tree = render([{ kind: 'site', id: 'site', title: 'Site', url: 'https://example.test/' }, { kind: 'plugin', id: 'removed', title: 'Removed' }]);
        const links = tree.root.findAllByProps({ accessibilityRole: 'link' });
        act(() => links[0].props.onPress());expect(mocks.external).toHaveBeenCalledWith('https://example.test/');
        act(() => links[1].props.onPress());expect(mocks.alert).toHaveBeenCalledWith('composerContext.contextUnavailable');
        expect(mocks.navigate).not.toHaveBeenCalled();act(() => tree.unmount());
    });
});

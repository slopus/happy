import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';

const state = vi.hoisted(() => ({ skin: 'dreamskin' }));

vi.mock('@/components/AppStack', async () => {
    const ReactModule = await import('react');
    const Stack = Object.assign(
        (props: any) => ReactModule.createElement('Stack', props, props.children),
        { Screen: (props: any) => ReactModule.createElement('Screen', props) },
    );
    return { Stack };
});
vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => true }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => state.skin }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/navigation/Header', () => ({ createHeader: () => null }));
vi.mock('@/components/CardStackScene', () => ({ CardStackScene: ({ children }: any) => children }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { surface: '#222', header: { background: '#222', tint: '#fff' } } } }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));

import RootLayout from './_layout';

describe('DreamSkin stack backgrounds', () => {
    it('lets only the home and conversation reveal the workspace photograph', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<RootLayout />); });
        const stack = renderer.root.findByType('Stack');
        const screen = (name: string) => renderer.root.findAllByType('Screen').find((entry: any) => entry.props.name === name);

        expect(stack.props.screenOptions.contentStyle.backgroundColor).toBe('#222');
        expect(screen('index').props.options.contentStyle.backgroundColor).toBe('transparent');
        expect(screen('new/index').props.options.contentStyle.backgroundColor).toBe('transparent');
        expect(screen('session/[id]').props.options.contentStyle.backgroundColor).toBe('transparent');
        expect(screen('settings/appearance').props.options.contentStyle).toBeUndefined();
        expect(screen('session/search').props.options.contentStyle).toBeUndefined();

        state.skin = 'default';
        act(() => renderer.update(<RootLayout />));
        expect(screen('index').props.options.contentStyle).toBeUndefined();
        expect(screen('new/index').props.options.contentStyle).toBeUndefined();
        expect(screen('session/[id]').props.options.contentStyle).toBeUndefined();
        act(() => renderer.unmount());
        state.skin = 'dreamskin';
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });
});

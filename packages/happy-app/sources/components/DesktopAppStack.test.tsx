import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error narrow renderer harness
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), back: vi.fn(), descriptors: null as Record<string, any> | null }));
vi.mock('react-native', () => ({ Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('@react-navigation/native', () => ({
    createNavigatorFactory: (component: any) => () => ({ Navigator: component }),
    useNavigationBuilder: () => ({ state: mocks.state, descriptors: mocks.descriptors ?? Object.fromEntries(mocks.state.routes.map((route: any) => [route.key, { route, render: () => null, options: { headerTitle: route.name, headerRight: () => 'action' } }])), navigation: { dispatch: mocks.dispatch, goBack: mocks.back }, describe: vi.fn(), NavigationContent: React.Fragment }),
}));
vi.mock('@react-navigation/native-stack', () => ({ NativeStackView: ({ state, descriptors }: any) => React.createElement(
    'NativeStackView', { state, descriptors }, descriptors[state.routes[state.index].key]?.render(),
) }));
vi.mock('expo-router', () => ({ withLayoutContext: (component: any) => component }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ DesktopWorkspaceLayoutIsolation: ({ children }: any) => children }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'surface', surfacePressed: 'pressed', divider: 'divider', shadow: { color: 'shadow' }, header: { tint: 'tint', background: 'header' } } };
    return { StyleSheet: { create: (f: any) => f(theme), absoluteFill: {}, hairlineWidth: 1 }, useUnistyles: () => ({ theme }) };
});
import { DesktopStackNavigator, focusDesktopModalInitialTarget } from './DesktopAppStack';
import { navigateDesktopModalBack } from '@/navigation/desktopModalNavigation';
let renderer: any;
afterEach(() => {
    act(() => renderer?.unmount());
    mocks.descriptors = null;
    mocks.back.mockReset();
    mocks.dispatch.mockReset();
});

describe('desktop app stack presentation', () => {
    it('preserves focus already placed inside modal content before applying the close-button fallback', () => {
        const focus = vi.fn();
        const activeElement = {} as HTMLElement;
        const panel = {
            contains: vi.fn(() => true),
            querySelector: vi.fn(() => ({ focus })),
        } as unknown as HTMLElement;

        focusDesktopModalInitialTarget(panel, activeElement);

        expect(panel.contains).toHaveBeenCalledWith(activeElement);
        expect(panel.querySelector).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
    });

    it('focuses the modal close button when content has not claimed focus', () => {
        const focus = vi.fn();
        const activeElement = {} as HTMLElement;
        const panel = {
            contains: vi.fn(() => false),
            querySelector: vi.fn(() => ({ focus })),
        } as unknown as HTMLElement;

        focusDesktopModalInitialTarget(panel, activeElement);

        expect(panel.querySelector).toHaveBeenCalledWith('[data-testid="desktop-modal-close"]');
        expect(focus).toHaveBeenCalledOnce();
    });

    it('renders only background outside and only descendants inside, including during close animation', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const background = { key: 'background', name: 'session/[id]', params: { id: 'original' } };
        mocks.state = { key: 'app', index: 2, routes: [background, { key: 'inbox', name: 'inbox/index' }, { key: 'profile', name: 'settings/profile' }], preloadedRoutes: [{ key: 'preload', name: 'dev/index' }], desktopModalBaseKey: 'background' };
        act(() => { renderer = TestRenderer.create(<DesktopStackNavigator children={null} />); });
        const stacks = renderer.root.findAllByType('NativeStackView');
        expect(stacks).toHaveLength(2);
        expect(stacks[0].props.state.routes).toEqual([background]);
        expect(stacks[1].props.state.routes.map((r: any) => r.key)).toEqual(['inbox', 'profile']);
        expect(stacks[0].props.state.preloadedRoutes).toEqual([]);
        expect(stacks[1].props.state.preloadedRoutes).toEqual([]);
        expect(renderer.root.findByProps({ testID: 'desktop-modal-back' })).toBeDefined();
        expect(navigateDesktopModalBack(false)).toBe(true);
        expect(mocks.back).toHaveBeenCalled();
        act(() => renderer.root.findByProps({ testID: 'desktop-modal-close' }).props.onPress());
        expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'CLOSE_DESKTOP_MODAL', target: 'app' });
        mocks.state = { ...mocks.state, routes: [background], index: 0, desktopModalBaseKey: undefined };
        act(() => renderer.update(<DesktopStackNavigator children={null} />));
        expect(renderer.root.findAllByType('NativeStackView')).toHaveLength(1);
        expect(navigateDesktopModalBack(false)).toBe(false);
    });

    it('renders the Device Environment title and content within Settings before returning to the background', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        const background = { key: 'background', name: 'session/[id]', params: { id: 'original' } };
        const settings = { key: 'settings', name: 'settings/index' };
        const environment = { key: 'environment', name: 'settings/device-environment' };
        mocks.state = { key: 'app', index: 2, routes: [background, settings, environment], preloadedRoutes: [], desktopModalBaseKey: 'background' };
        mocks.descriptors = {
            background: { route: background, render: () => React.createElement('Text', null, 'Workspace content'), options: { headerTitle: 'Workspace' } },
            settings: { route: settings, render: () => React.createElement('Text', null, 'Settings content'), options: { headerTitle: 'Settings' } },
            environment: { route: environment, render: () => React.createElement('Text', null, 'Device Environment content'), options: { headerTitle: 'Device Environment' } },
        };

        act(() => { renderer = TestRenderer.create(<DesktopStackNavigator children={null} />); });
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join(''))).toContain('Device Environment');
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join(''))).toContain('Device Environment content');

        mocks.state = { ...mocks.state, index: 1, routes: [background, settings] };
        act(() => renderer.update(<DesktopStackNavigator children={null} />));
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join(''))).toContain('Settings');
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join(''))).toContain('Settings content');

        mocks.state = { ...mocks.state, index: 0, routes: [background], desktopModalBaseKey: undefined };
        act(() => renderer.update(<DesktopStackNavigator children={null} />));
        expect(renderer.root.findByType('Modal').props.visible).toBe(false);
        expect(renderer.root.findAllByType('Text').map((node: any) => node.children.join(''))).toContain('Workspace content');
    });
});

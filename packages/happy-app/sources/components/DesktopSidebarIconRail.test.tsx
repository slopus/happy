import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    pluginViews: [] as Array<{ componentId: string }>,
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    return {
        Platform: { OS: 'web' },
        Pressable: ({ children, ...props }: any) => ReactModule.createElement(
            'Pressable',
            props,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        Text: 'Text',
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ usePathname: () => '/relationship-advisor' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({ colors: {
            button: { destructive: { background: '#b42318', backgroundPressed: '#8f1d14', tint: '#fff' } },
            divider: '#ddd', status: { error: '#d33' }, surface: '#fff', surfaceHigh: '#f5f5f5',
            surfacePressed: '#eee', surfaceSelected: '#e5e5e5', text: '#111', textSecondary: '#666',
        } }),
    },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#666' } } }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./SidebarAccountMenu', () => ({ SidebarAccountMenu: 'SidebarAccountMenu' }));
vi.mock('./SidebarHelpMenu', () => ({ SidebarHelpMenu: 'SidebarHelpMenu' }));
vi.mock('./plugins/usePluginSurfaceViews', () => ({ usePluginSurfaceViews: () => mocks.pluginViews }));

import { DesktopSidebarIconRail } from './DesktopSidebarIconRail';

function renderRail(overrides: Record<string, unknown> = {}) {
    return TestRenderer.create(<DesktopSidebarIconRail
        displayName="Jacky"
        footerMenu={null}
        onFooterMenuChange={vi.fn()}
        onNavigate={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenPluginMarketplace={vi.fn()}
        onOpenSessionSearch={vi.fn()}
        onOpenSettings={vi.fn()}
        profile={{ id: 'user', timestamp: 0, firstName: 'Jacky', lastName: null, avatar: null, github: null, connectedServices: [] }}
        unreadCount={3}
        {...overrides}
    />);
}

describe('DesktopSidebarIconRail', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pluginViews = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('keeps every historical global entry as an icon-only action', () => {
        let renderer: any;
        act(() => { renderer = renderRail(); });

        expect(renderer.root.findByType('SidebarAccountMenu').props.iconOnly).toBe(true);
        expect([
            'sidebar-new-session-button',
            'sidebar-inbox-button',
            'sidebar-command-palette-button',
            'sidebar-plugins-button',
            'sidebar-my-agents-button',
            'sidebar-notifications-button',
        ].every((testID) => renderer.root.findAllByProps({ testID }).length > 0)).toBe(true);
        expect(renderer.root.findByType('SidebarHelpMenu').props.iconRail).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-conversation-history-button' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('shows localized hover/focus tooltips without adding permanent text labels', () => {
        let renderer: any;
        act(() => { renderer = renderRail(); });
        const search = renderer.root.findAllByProps({ testID: 'sidebar-command-palette-button' })
            .find((node: any) => typeof node.props.onFocus === 'function');

        expect(search).toBeDefined();
        act(() => search.props.onFocus());
        expect(renderer.root.findByProps({ testID: 'sidebar-command-palette-button-tooltip' }).findByType('Text').props.children)
            .toBe('sidebar.searchSessions');
        act(() => search.props.onBlur());
        expect(renderer.root.findAllByProps({ testID: 'sidebar-command-palette-button-tooltip' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('restores the conversation history icon when its existing plugin surface is installed', () => {
        mocks.pluginViews = [{ componentId: 'relationship-advisor-history' }];
        const navigate = vi.fn();
        let renderer: any;
        act(() => { renderer = renderRail({ onNavigate: navigate }); });

        act(() => renderer.root.findByProps({ testID: 'sidebar-conversation-history-button' }).props.onPress());
        expect(navigate).toHaveBeenCalledWith('/relationship-advisor');
        expect(renderer.root.findAllByProps({ testID: 'sidebar-conversation-history-button' }).some(
            (node: any) => node.props['aria-current'] === 'page',
        )).toBe(true);
        act(() => renderer.unmount());
    });
});

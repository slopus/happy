import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopRightPanel } from './DesktopRightPanel';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('expo-router', () => ({ usePathname: () => mocks.pathname }));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                groupped: { background: '#f8f8f8' },
                surface: '#fff',
                divider: '#ddd',
                surfacePressed: '#eee',
                text: '#111',
                textSecondary: '#777',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#f8f8f8' },
                surface: '#fff',
                divider: '#ddd',
                surfacePressed: '#eee',
                text: '#111',
                textSecondary: '#777',
            },
        },
    }),
}));
vi.mock('./DesktopPanelResizeHandle', () => ({ DesktopPanelResizeHandle: 'DesktopPanelResizeHandle' }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ useDesktopWorkspaceLayout: () => ({ enabled: true }) }));
vi.mock('@/utils/desktopNavigationLayout', () => ({
    getDesktopPanelShortcutPresentation: () => ({ rightLabel: '⌘]', rightAria: 'Meta+]'}),
    isSettingsModalRoute: (pathname: string) => pathname === '/settings' || pathname.startsWith('/settings/'),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('DesktopRightPanel', () => {
    beforeEach(() => {
        mocks.pathname = '/';
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('removes the high-layer resize handle while settings is modal', () => {
        mocks.pathname = '/settings/appearance';
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <DesktopRightPanel
                    activeTab="capabilities"
                    collapseAccessibilityLabel="Collapse"
                    collapseLabel="Collapse"
                    onCollapse={vi.fn()}
                    onTabChange={vi.fn()}
                    tabs={[{ key: 'capabilities', label: 'Capabilities', icon: 'sparkles-outline' }]}
                >
                    <React.Fragment />
                </DesktopRightPanel>,
            );
        });

        expect(renderer.root.findAllByType('DesktopPanelResizeHandle')).toHaveLength(0);
        act(() => renderer.unmount());
    });
});

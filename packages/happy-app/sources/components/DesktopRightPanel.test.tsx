import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopRightPanel, DesktopRightPanelFrame } from './DesktopRightPanel';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ resizable: true }));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', Ionicons: 'Ionicons' }));
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
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ useDesktopWorkspaceLayout: () => ({ enabled: mocks.resizable }) }));
vi.mock('@/utils/desktopNavigationLayout', () => ({
    getDesktopPanelShortcutPresentation: () => ({ rightLabel: '⌘]', rightAria: 'Meta+]'}),
}));
vi.mock('@/text', () => ({ t: (key: string, params?: { panel: string }) => params ? `${key}:${params.panel}` : key }));

const flatten = (style: any) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.resizable = true;
});

describe('DesktopRightPanel', () => {
    it('keeps the resize handle independent from settings routes', () => {
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

        expect(renderer.root.findAllByType('DesktopPanelResizeHandle')).toHaveLength(1);
        act(() => renderer.unmount());
    });
});

// The photograph must be tinted once by the pane, including behind its header.
it.each([undefined, 'rgba(21,26,33,0.51)', '#151A21'])('owns one pane surface with color %s', (surfaceColor) => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(
        <DesktopRightPanel activeTab="files" collapseAccessibilityLabel="Collapse" collapseLabel="Collapse"
            onCollapse={vi.fn()} onTabChange={vi.fn()} surfaceColor={surfaceColor}
            tabs={[{ key: 'files', label: 'Files', icon: 'folder-outline' }]}><React.Fragment /></DesktopRightPanel>,
    ); });
    const pane = renderer.root.findByProps({ testID: 'desktop-right-panel' });
    expect(flatten(pane.props.style).backgroundColor).toBe(surfaceColor ?? '#fff');
    const header = pane.findAll((node: any) => node.type === 'View' && flatten(node.props.style).minHeight === 48)[0];
    expect(flatten(header.props.style).backgroundColor).toBe(surfaceColor ? 'transparent' : '#fff');
    act(() => renderer.unmount());
});

describe('DesktopRightPanelFrame', () => {
    it.each([undefined, 'rgba(21,26,33,0.51)', '#151A21'])('keeps detail content inside the rounded, resizable pane with surface %s', (surfaceColor) => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(
            <DesktopRightPanelFrame panelLabel="Task details" surfaceColor={surfaceColor}>
                <React.Fragment><ViewForTest /></React.Fragment>
            </DesktopRightPanelFrame>,
        ); });
        const pane = renderer.root.findByProps({ testID: 'desktop-right-panel' });
        expect(flatten(pane.props.style)).toMatchObject({
            backgroundColor: surfaceColor ?? '#fff',
            borderRadius: 20,
            overflow: 'hidden',
            minHeight: 0,
        });
        expect(pane.findAllByType('DesktopPanelResizeHandle')).toHaveLength(1);
        expect(pane.findByType('DesktopPanelResizeHandle').props).toMatchObject({
            accessibilityLabel: 'desktopWorkspace.resizePanel:Task details',
            offset: 0,
            side: 'right',
        });
        expect(pane.findAllByType('InspectorContent')).toHaveLength(1);
        expect(pane.findAllByProps({ accessibilityRole: 'tablist' })).toHaveLength(0);
        expect(pane.findAllByProps({ testID: 'desktop-right-panel-collapse-button' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('preserves the non-resizable layout and supports a detail-specific test ID', () => {
        mocks.resizable = false;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(
            <DesktopRightPanelFrame panelLabel="Task details" testID="desktop-inspector-frame">
                <ViewForTest />
            </DesktopRightPanelFrame>,
        ); });
        const pane = renderer.root.findAllByType('View').find((node: any) => node.props.testID === 'desktop-inspector-frame');
        expect(flatten(pane.props.style)).toMatchObject({ backgroundColor: '#f8f8f8', borderLeftWidth: 1 });
        expect(flatten(pane.props.style).borderRadius).toBeUndefined();
        expect(renderer.root.findAllByType('DesktopPanelResizeHandle')).toHaveLength(0);
        act(() => renderer.unmount());
    });
});

function ViewForTest() {
    return React.createElement('InspectorContent');
}

import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    firstActionFocus: vi.fn(),
    keydownHandler: null as ((event: any) => void) | null,
    openExternalUrl: vi.fn(),
    openShortcuts: vi.fn(),
    triggerFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            focus: props.testID === 'sidebar-help-trigger'
                ? mocks.triggerFocus
                : props.testID === 'sidebar-help-shortcuts-action'
                    ? mocks.firstActionFocus
                    : vi.fn(),
        }), [props.testID]);
        return ReactModule.createElement('Pressable', props, props.children);
    });

    return {
        Platform: { OS: 'web' },
        Pressable,
        Text: 'Text',
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            groupped: { background: '#f5f5f5' },
            shadow: { color: '#000', opacity: 0.2 },
            surface: '#fff',
            surfacePressed: '#eee',
            text: '#111',
            textSecondary: '#666',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/components/KeyboardShortcuts', () => ({
    useKeyboardShortcutsLauncher: () => ({
        isAvailable: true,
        open: mocks.openShortcuts,
    }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: mocks.openExternalUrl }));

import { SidebarHelpMenu } from './SidebarHelpMenu';

function HelpMenuHarness() {
    const [open, setOpen] = React.useState(false);
    return <SidebarHelpMenu onOpenChange={setOpen} open={open} />;
}

describe('SidebarHelpMenu', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.keydownHandler = null;
        vi.stubGlobal('window', {
            addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
                if (event === 'keydown') mocks.keydownHandler = handler;
            }),
            removeEventListener: vi.fn(),
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('exposes a localized menu trigger and focuses the shortcuts action when opened', () => {
        act(() => {
            renderer = TestRenderer.create(<HelpMenuHarness />);
        });

        const trigger = renderer.root.findByProps({ testID: 'sidebar-help-trigger' });
        expect(trigger.props.accessibilityRole).toBe('button');
        expect(trigger.props.accessibilityLabel).toBe('keyboardShortcuts.help');
        expect(trigger.props['aria-haspopup']).toBe('menu');
        expect(trigger.props['aria-expanded']).toBe(false);
        expect(trigger.props.accessibilityState).toEqual({ expanded: false });

        act(() => trigger.props.onPress());
        expect(renderer.root.findByProps({ testID: 'sidebar-help-trigger' }).props['aria-expanded']).toBe(true);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.firstActionFocus).toHaveBeenCalledOnce();
    });

    it('closes and focuses the stable trigger before opening keyboard shortcuts', () => {
        act(() => {
            renderer = TestRenderer.create(<HelpMenuHarness />);
        });
        act(() => renderer.root.findByProps({ testID: 'sidebar-help-trigger' }).props.onPress());
        act(() => vi.runOnlyPendingTimers());
        mocks.triggerFocus.mockClear();

        act(() => renderer.root.findByProps({ testID: 'sidebar-help-shortcuts-action' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(mocks.openShortcuts).toHaveBeenCalledOnce();
        expect(mocks.triggerFocus.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.openShortcuts.mock.invocationCallOrder[0],
        );
    });

    it('closes and opens the existing issue destination', () => {
        act(() => {
            renderer = TestRenderer.create(<HelpMenuHarness />);
        });
        act(() => renderer.root.findByProps({ testID: 'sidebar-help-trigger' }).props.onPress());

        act(() => renderer.root.findByProps({ testID: 'sidebar-help-report-action' }).props.onPress());

        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://github.com/wangjs-jacky/happy/issues');
    });

    it('prevents Escape propagation, closes, and restores trigger focus', () => {
        act(() => {
            renderer = TestRenderer.create(<HelpMenuHarness />);
        });
        act(() => renderer.root.findByProps({ testID: 'sidebar-help-trigger' }).props.onPress());
        act(() => vi.runOnlyPendingTimers());

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        act(() => mocks.keydownHandler?.({ key: 'Escape', preventDefault, stopPropagation }));
        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
    });

    it('anchors a fixed-width menu above the right-aligned trigger with menu semantics', () => {
        act(() => {
            renderer = TestRenderer.create(<SidebarHelpMenu onOpenChange={vi.fn()} open />);
        });

        const menu = renderer.root.findByProps({ testID: 'sidebar-help-menu' });
        expect(menu.props.accessibilityRole).toBe('menu');
        expect(menu.props.accessibilityViewIsModal).toBe(true);
        expect(menu.props.style).toEqual(expect.objectContaining({
            bottom: '100%',
            position: 'absolute',
            right: 10,
            width: 224,
        }));
        const actions = menu.findAllByType('Pressable');
        expect(actions.find((node: any) => node.props.testID === 'sidebar-help-shortcuts-action')?.props.accessibilityRole)
            .toBe('menuitem');
        expect(actions.find((node: any) => node.props.testID === 'sidebar-help-report-action')?.props.accessibilityRole)
            .toBe('menuitem');
    });
});

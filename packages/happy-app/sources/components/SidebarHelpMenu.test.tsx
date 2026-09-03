// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    applyLocalSettings: vi.fn(),
    dismissTopModal: vi.fn(() => true),
    firstActionFocus: vi.fn(),
    launcherAvailable: true,
    overlayBack: vi.fn(() => true),
    openExternalUrl: vi.fn(),
    openShortcuts: vi.fn(),
    routeBack: vi.fn(),
    syncRoutePathname: vi.fn(),
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
        isAvailable: mocks.launcherAvailable,
        open: mocks.openShortcuts,
    }),
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('@/modal', () => ({
    useModal: () => ({ dismissTopModal: mocks.dismissTopModal }),
}));
vi.mock('@/-session/sessionOverlayNav', () => ({
    useOverlayNav: {
        getState: () => ({ back: mocks.overlayBack }),
    },
}));
vi.mock('@/navigation/browserNavigation', () => ({
    canRouteBack: () => true,
    canRouteForward: () => false,
    canUseRouteBack: () => true,
    getNavigatorCanGoBack: () => true,
    getKeyboardNavigationDirection: (event: KeyboardEvent) => event.key === 'Escape' ? 'back' : null,
    getMouseNavigationDirection: () => null,
}));
vi.mock('@/navigation/browserNavigationStore', () => {
    const state = {
        markRouteBack: vi.fn(),
        markRouteForward: vi.fn(),
        routeHistory: { entries: ['/'], index: 0 },
        syncRoutePathname: mocks.syncRoutePathname,
    };
    const useBrowserNavigationStore = Object.assign(
        (selector: (value: typeof state) => unknown) => selector(state),
        { getState: () => state },
    );
    return { useBrowserNavigationStore };
});
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            applyLocalSettings: mocks.applyLocalSettings,
            localSettings: { zenMode: true },
        }),
    },
}));
vi.mock('expo-router', () => ({
    useGlobalSearchParams: () => ({}),
    usePathname: () => '/',
    useRouter: () => ({ back: mocks.routeBack, canGoBack: () => true }),
}));

import { SidebarHelpMenu } from './SidebarHelpMenu';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';

function HelpMenuHarness() {
    const [open, setOpen] = React.useState(false);
    return <SidebarHelpMenu onOpenChange={setOpen} open={open} />;
}

function BrowserAndHelpHarness() {
    const [open, setOpen] = React.useState(true);
    return (
        <>
            <BrowserNavigationShortcuts />
            <SidebarHelpMenu onOpenChange={setOpen} open={open} />
        </>
    );
}

describe('SidebarHelpMenu', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.launcherAvailable = true;
        mocks.dismissTopModal.mockReturnValue(true);
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

        const event = new KeyboardEvent('keydown', { cancelable: true, key: 'Escape' });
        const stopPropagation = vi.spyOn(event, 'stopPropagation');
        const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation');
        act(() => window.dispatchEvent(event));
        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(event.defaultPrevented).toBe(true);
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
    });

    it('closes Help before the browser Escape handler can dismiss another application layer', () => {
        act(() => {
            renderer = TestRenderer.create(<BrowserAndHelpHarness />);
        });
        act(() => vi.runOnlyPendingTimers());

        act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        })));

        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);
        expect(mocks.dismissTopModal).not.toHaveBeenCalled();
        expect(mocks.applyLocalSettings).not.toHaveBeenCalled();
        expect(mocks.overlayBack).not.toHaveBeenCalled();
        expect(mocks.routeBack).not.toHaveBeenCalled();
    });

    it('does not restore its trigger while focus transfers to another footer menu', () => {
        const onOpenChange = vi.fn();
        act(() => {
            renderer = TestRenderer.create(
                <SidebarHelpMenu
                    onOpenChange={onOpenChange}
                    open
                    restoreFocusOnClose={false}
                />,
            );
        });
        act(() => vi.runOnlyPendingTimers());
        mocks.triggerFocus.mockClear();

        act(() => renderer.update(
            <SidebarHelpMenu
                onOpenChange={onOpenChange}
                open={false}
                restoreFocusOnClose={false}
            />,
        ));
        act(() => vi.runOnlyPendingTimers());

        expect(mocks.triggerFocus).not.toHaveBeenCalled();
    });

    it('renders no help affordance and closes stale state when shortcuts are unavailable', () => {
        mocks.launcherAvailable = false;
        const onOpenChange = vi.fn();

        act(() => {
            renderer = TestRenderer.create(<SidebarHelpMenu onOpenChange={onOpenChange} open />);
        });

        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-trigger' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'sidebar-help-menu' })).toHaveLength(0);
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('anchors a fixed-width menu above the right-aligned trigger with menu semantics', () => {
        act(() => {
            renderer = TestRenderer.create(<SidebarHelpMenu onOpenChange={vi.fn()} open />);
        });

        const menu = renderer.root.findByProps({ testID: 'sidebar-help-menu' });
        expect(menu.props.accessibilityRole).toBe('menu');
        expect(menu.props.accessibilityLabel).toBe('keyboardShortcuts.help');
        expect(menu.props.accessibilityViewIsModal).toBe(true);
        expect(menu.props.style).toContainEqual(expect.objectContaining({
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

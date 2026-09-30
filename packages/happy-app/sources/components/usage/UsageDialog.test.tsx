import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    closeFocus: vi.fn(),
    returnFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({ focus: mocks.closeFocus }), []);
        return ReactModule.createElement('Pressable', props, props.children);
    });
    return {
        Modal: ({ children, visible, ...props }: any) => visible
            ? ReactModule.createElement('Modal', props, children)
            : null,
        Platform: { OS: 'web' },
        Pressable,
        Text: 'Text',
        useWindowDimensions: () => ({ height: 900, width: 1280 }),
        View: 'View',
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const activeTheme = {
        colors: {
            divider: '#263344',
            shadow: { color: '#000', opacity: 0.3 },
            surface: '#1a2330',
            surfacePressed: '#1f2a38',
            surfaceSelected: '#283544',
            text: '#fff',
            textSecondary: '#aaa',
        },
    };
    return {
        StyleSheet: {
            absoluteFillObject: { bottom: 0, left: 0, right: 0, top: 0 },
            hairlineWidth: 1,
            create: (factory: any) => factory(activeTheme),
        },
        useUnistyles: () => ({
            theme: {
                colors: {
                    divider: '#4b3729',
                    shadow: { color: '#000', opacity: 0.3 },
                    surface: '#271b12',
                    surfacePressed: '#35261a',
                    surfaceSelected: '#3f2d20',
                    text: '#f5dfca',
                    textSecondary: '#c8a98a',
                },
            },
        }),
    };
});
vi.mock('@/components/usage/UsagePanel', () => ({ UsagePanel: 'UsagePanel' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

import { getUsageDialogLayout, UsageDialog } from './UsageDialog';

describe('UsageDialog', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
    });

    it('uses a wide desktop dialog and keeps narrow layouts inside the viewport', () => {
        expect(getUsageDialogLayout({ height: 900, width: 1280 })).toEqual({ height: 828, width: 1100 });
        expect(getUsageDialogLayout({ height: 760, width: 390 })).toEqual({ height: 736, width: 366 });
    });

    it('keeps a narrow dialog clear of Android system bars', () => {
        expect(getUsageDialogLayout(
            { height: 760, width: 390 },
            { bottom: 24, left: 0, right: 0, top: 36 },
        )).toEqual({ height: 676, width: 366 });
    });

    it('focuses close on open and restores the trigger after closing', () => {
        act(() => {
            renderer = TestRenderer.create(
                <UsageDialog
                    onClose={mocks.close}
                    open
                    returnFocusRef={{ current: { focus: mocks.returnFocus } }}
                />,
            );
        });
        act(() => vi.runOnlyPendingTimers());

        expect(mocks.closeFocus).toHaveBeenCalledOnce();
        expect(renderer.root.findAllByType('UsagePanel')).toHaveLength(1);

        act(() => renderer.root.findByProps({ testID: 'sidebar-account-usage-dialog-close' }).props.onPress());
        expect(mocks.close).toHaveBeenCalledOnce();
        act(() => vi.runOnlyPendingTimers());
        expect(mocks.returnFocus).toHaveBeenCalledOnce();
    });

    it('keeps dialog surfaces on the active theme-pack tokens', () => {
        act(() => {
            renderer = TestRenderer.create(<UsageDialog onClose={mocks.close} open />);
        });

        const dialogStyle = Object.assign({}, ...renderer.root
            .findByProps({ testID: 'sidebar-account-usage-dialog' })
            .props.style.flat());
        expect(dialogStyle).toEqual(expect.objectContaining({
            backgroundColor: '#1a2330',
            borderColor: '#263344',
        }));

        const closeButton = renderer.root.findByProps({ testID: 'sidebar-account-usage-dialog-close' });
        expect(closeButton.props.style({ pressed: true })).toContainEqual(expect.objectContaining({
            backgroundColor: '#1f2a38',
        }));
    });

    it('uses semantic rest, focus, hover, and pressed surfaces for the close button on Web', () => {
        act(() => {
            renderer = TestRenderer.create(<UsageDialog onClose={mocks.close} open />);
        });

        let closeButton = renderer.root.findByProps({ testID: 'sidebar-account-usage-dialog-close' });
        expect(closeButton.props.style({ pressed: false })).toContainEqual(expect.objectContaining({
            backgroundColor: '#1a2330',
        }));
        expect(closeButton.props.onFocus).toEqual(expect.any(Function));
        act(() => closeButton.props.onFocus());

        closeButton = renderer.root.findByProps({ testID: 'sidebar-account-usage-dialog-close' });
        expect(closeButton.props.style({ pressed: false })).toContainEqual(expect.objectContaining({
            backgroundColor: '#283544',
        }));
        expect(closeButton.props.onHoverIn).toEqual(expect.any(Function));
        act(() => closeButton.props.onHoverIn());

        closeButton = renderer.root.findByProps({ testID: 'sidebar-account-usage-dialog-close' });
        expect(closeButton.props.style({ pressed: false })).toContainEqual(expect.objectContaining({
            backgroundColor: '#1f2a38',
        }));
        expect(closeButton.props.style({ pressed: true })).toContainEqual(expect.objectContaining({
            backgroundColor: '#1f2a38',
        }));
    });
});

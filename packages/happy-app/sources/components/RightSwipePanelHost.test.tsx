import * as React from 'react';
import { act } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightSwipePanelHost, useRightSwipePanel } from './RightSwipePanelHost';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

type SpringCompletion = (finished?: boolean) => void;

const mocks = vi.hoisted(() => ({
    gestureEnabledValues: [] as boolean[],
    gestureHandlers: {} as Record<string, (...args: any[]) => void>,
    springCompletions: [] as Array<SpringCompletion | undefined>,
}));

vi.mock('react-native', () => ({
    BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    View: 'View',
    useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('expo-router', () => ({
    useNavigation: () => ({ addListener: vi.fn(() => vi.fn()) }),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => {
            const theme = { colors: { surface: '#111', divider: '#333' } };
            return typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory;
        },
    },
}));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('react-native-drawer-layout', async () => {
    const ReactModule = await vi.importActual<typeof import('react')>('react');
    return { DrawerGestureContext: ReactModule.createContext(null) };
});
vi.mock('react-native-gesture-handler', () => {
    const makePan = () => {
        const pan: Record<string, any> = {};
        for (const method of [
            'enabled',
            'manualActivation',
            'onTouchesDown',
            'onTouchesMove',
            'onStart',
            'onUpdate',
            'onEnd',
            'blocksExternalGesture',
        ]) {
            pan[method] = (value: unknown) => {
                if (method === 'enabled') {
                    mocks.gestureEnabledValues.push(value as boolean);
                }
                if (method.startsWith('on') && typeof value === 'function') {
                    mocks.gestureHandlers[method] = value as (...args: any[]) => void;
                }
                return pan;
            };
        }
        return pan;
    };

    return {
        Gesture: { Pan: vi.fn(makePan) },
        GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    };
});
vi.mock('react-native-reanimated', async () => {
    const ReactModule = await vi.importActual<typeof import('react')>('react');
    return {
        default: { View: 'AnimatedView' },
        runOnJS: (callback: (...args: any[]) => unknown) => callback,
        useAnimatedStyle: (factory: () => object) => factory(),
        useSharedValue: (value: number) => ReactModule.useRef({ value }).current,
        withSpring: (_value: number, _config: unknown, completion?: SpringCompletion) => {
            mocks.springCompletions.push(completion);
            return _value;
        },
    };
});

function CloseControl(props: { callback?: () => void; testID: string }) {
    const panel = useRightSwipePanel();
    return (
        <Pressable
            testID={props.testID}
            onPress={() => panel?.closePanel(props.callback)}
        />
    );
}

function NestedBackControl(props: { onBack: () => void }) {
    const panel = useRightSwipePanel();
    React.useEffect(() => panel?.registerBackHandler(() => {
        props.onBack();
        return true;
    }), [panel, props.onBack]);
    return null;
}

const PANEL_ACCESSIBILITY_LABELS = {
    closeAccessibilityLabel: 'Hide context panel',
    openAccessibilityLabel: 'Show context panel',
    panelAccessibilityLabel: 'Context panel',
};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) return (style ?? {}) as Record<string, unknown>;
    return Object.assign({}, ...style.filter(Boolean));
}

function renderHost(callback?: () => void, enabled?: boolean, gestureEnabled = true) {
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(
            <RightSwipePanelHost
                {...PANEL_ACCESSIBILITY_LABELS}
                enabled={enabled}
                gestureEnabled={gestureEnabled}
                panelContent={(
                    <>
                        <CloseControl callback={callback} testID="close-with-callback" />
                        <CloseControl testID="close-without-callback" />
                    </>
                )}
            >
                <View />
            </RightSwipePanelHost>,
        );
    });
    return renderer;
}

function latestSpringCompletion(): SpringCompletion {
    const completion = mocks.springCompletions.at(-1);
    expect(completion).toBeTypeOf('function');
    return completion!;
}

function findControl(renderer: any, testID: string) {
    return renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === testID);
}

describe('RightSwipePanelHost close completion', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.gestureEnabledValues = [];
        mocks.gestureHandlers = {};
        mocks.springCompletions = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('calls the close callback exactly once after a finished spring', () => {
        const callback = vi.fn();
        const renderer = renderHost(callback);

        act(() => findControl(renderer, 'close-with-callback').props.onPress());
        const complete = latestSpringCompletion();
        expect(callback).not.toHaveBeenCalled();

        act(() => complete(true));
        act(() => complete(true));

        expect(callback).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('does not call the close callback when the spring is interrupted', () => {
        const callback = vi.fn();
        const renderer = renderHost(callback);

        act(() => findControl(renderer, 'close-with-callback').props.onPress());
        act(() => latestSpringCompletion()(false));

        expect(callback).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('lets a newer close supersede a stale close callback', () => {
        const first = vi.fn();
        const second = vi.fn();
        const renderer = renderHost(first);
        const control = findControl(renderer, 'close-with-callback');

        act(() => control.props.onPress());
        const completeFirst = latestSpringCompletion();
        // Re-rendering supplies the second callback through the same public context API.
        act(() => renderer.update(
            <RightSwipePanelHost
                {...PANEL_ACCESSIBILITY_LABELS}
                gestureEnabled
                panelContent={<CloseControl callback={second} testID="close-with-callback" />}
            >
                <View />
            </RightSwipePanelHost>,
        ));
        act(() => findControl(renderer, 'close-with-callback').props.onPress());
        const completeSecond = latestSpringCompletion();

        act(() => completeFirst(true));
        expect(first).not.toHaveBeenCalled();
        act(() => completeSecond(true));
        expect(second).toHaveBeenCalledTimes(1);
        act(() => renderer.unmount());
    });

    it('invalidates a pending callback when a new panel gesture starts', () => {
        const callback = vi.fn();
        const renderer = renderHost(callback);

        act(() => findControl(renderer, 'close-with-callback').props.onPress());
        const complete = latestSpringCompletion();
        act(() => mocks.gestureHandlers.onStart());
        act(() => complete(true));

        expect(callback).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('invalidates a pending callback when the host unmounts before spring completion', () => {
        const callback = vi.fn();
        const renderer = renderHost(callback);

        act(() => findControl(renderer, 'close-with-callback').props.onPress());
        const complete = latestSpringCompletion();
        act(() => renderer.unmount());
        act(() => complete(true));

        expect(callback).not.toHaveBeenCalled();
    });

    it('preserves closePanel calls without a callback', () => {
        const renderer = renderHost();

        expect(() => {
            act(() => findControl(renderer, 'close-without-callback').props.onPress());
            act(() => latestSpringCompletion()(true));
        }).not.toThrow();

        act(() => renderer.unmount());
    });

    it('does not render a persistent edge handle on native phones', () => {
        const renderer = renderHost();

        expect(findControl(renderer, 'right-swipe-panel-edge-handle')).toBeUndefined();

        act(() => renderer.unmount());
    });

    it('can keep the drawer mounted without registering the horizontal pan gesture', () => {
        const renderer = renderHost(undefined, true, false);

        expect(mocks.gestureEnabledValues.at(-1)).toBe(false);
        expect(renderer.root.findByProps({ testID: 'right-swipe-panel-host' })).toBeDefined();

        act(() => renderer.unmount());
    });

    it('keeps the native panel available through a left swipe', () => {
        const renderer = renderHost();

        act(() => {
            mocks.gestureHandlers.onStart();
            mocks.gestureHandlers.onUpdate({ translationX: -160 });
            mocks.gestureHandlers.onEnd({ translationX: -160, velocityX: 0 });
        });
        expect(
            renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' }).props.accessibilityElementsHidden,
        ).toBe(false);

        act(() => renderer.unmount());
    });

    it('keeps a focusable narrow-screen edge handle on the web with expanded semantics', () => {
        (Platform as { OS: string }).OS = 'web';
        const renderer = renderHost(undefined, true);

        try {
            const handle = findControl(renderer, 'right-swipe-panel-edge-handle');
            const closedDrawer = renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' });

            expect(handle).toBeDefined();
            expect(handle.props.accessibilityRole).toBe('button');
            expect(handle.props.accessibilityState).toEqual({ expanded: false });
            expect(handle.props['aria-expanded']).toBe(false);
            expect(flattenStyle(handle.props.style)).toEqual(expect.objectContaining({
                backgroundColor: '#111',
                borderColor: '#333',
                minHeight: 40,
                minWidth: 40,
                top: 336,
            }));
            expect(flattenStyle(closedDrawer.props.style)).toEqual(expect.objectContaining({
                backgroundColor: '#111',
                paddingBottom: 12,
                paddingTop: 12,
            }));
            expect(closedDrawer.props.accessibilityElementsHidden).toBeUndefined();
            expect(closedDrawer.props.importantForAccessibility).toBeUndefined();

            act(() => handle.props.onPress());
            const openHandle = findControl(renderer, 'right-swipe-panel-edge-handle');
            expect(openHandle.props['aria-expanded']).toBe(true);
            expect(flattenStyle(openHandle.props.style)).toEqual(expect.objectContaining({ right: 288 }));
            expect(findControl(renderer, 'right-swipe-panel-close-button').props.accessibilityRole).toBe('button');
        } finally {
            act(() => renderer.unmount());
            (Platform as { OS: string }).OS = 'ios';
        }
    });

    it('can preserve edge-handle drawer geometry and swipe access without rendering the visible handle', () => {
        (Platform as { OS: string }).OS = 'web';
        let renderer: any;

        try {
            act(() => {
                renderer = TestRenderer.create(
                    <RightSwipePanelHost
                        {...PANEL_ACCESSIBILITY_LABELS}
                        enabled
                        gestureEnabled
                        mode="edge-handle"
                        panelContent={<View />}
                        showEdgeHandle={false}
                    >
                        <View />
                    </RightSwipePanelHost>,
                );
            });

            expect(findControl(renderer, 'right-swipe-panel-edge-handle')).toBeUndefined();
            expect(flattenStyle(renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' }).props.style))
                .toEqual(expect.objectContaining({ width: 288 }));

            act(() => {
                mocks.gestureHandlers.onStart();
                mocks.gestureHandlers.onUpdate({ translationX: -160 });
                mocks.gestureHandlers.onEnd({ translationX: -160, velocityX: 0 });
            });
            expect(renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' }).props.role).toBe('dialog');
        } finally {
            if (renderer) act(() => renderer.unmount());
            (Platform as { OS: string }).OS = 'ios';
        }
    });

    it('lets explicit hide controls close directly without consuming nested back', () => {
        const nestedBack = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <RightSwipePanelHost
                    {...PANEL_ACCESSIBILITY_LABELS}
                    gestureEnabled
                    panelContent={<NestedBackControl onBack={nestedBack} />}
                >
                    <View />
                </RightSwipePanelHost>,
            );
        });

        const open = () => act(() => {
            mocks.gestureHandlers.onStart();
            mocks.gestureHandlers.onUpdate({ translationX: -160 });
            mocks.gestureHandlers.onEnd({ translationX: -160, velocityX: 0 });
        });
        const completeClose = () => act(() => latestSpringCompletion()(true));

        open();
        act(() => findControl(renderer, 'right-swipe-panel-close-button').props.onPress());
        completeClose();
        expect(nestedBack).not.toHaveBeenCalled();

        open();
        act(() => findControl(renderer, 'right-swipe-panel-scrim').props.onPress());
        completeClose();
        expect(nestedBack).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('sizes the filmstrip from the measured host instead of the full window', () => {
        const renderer = renderHost();
        const host = renderer.root.findByProps({ testID: 'right-swipe-panel-host' });

        act(() => host.props.onLayout({ nativeEvent: { layout: { width: 550 } } }));

        const filmstrip = renderer.root.findAllByType('AnimatedView').find((node: any) => (
            Array.isArray(node.props.style)
            && node.props.style.some((style: any) => style?.flexDirection === 'row')
        ));
        expect(filmstrip).toBeDefined();
        expect(filmstrip.props.style).toContainEqual(expect.objectContaining({ width: 890 }));

        act(() => renderer.unmount());
    });

    it('keeps controlled web geometry atomic without translating the main workspace', () => {
        (Platform as { OS: string }).OS = 'web';
        let renderer: any;
        const renderControlled = (open: boolean) => (
            <RightSwipePanelHost
                {...PANEL_ACCESSIBILITY_LABELS}
                enabled
                gestureEnabled
                mode="drawer-toggle"
                open={open}
                panelContent={<View />}
            >
                <View />
            </RightSwipePanelHost>
        );

        try {
            act(() => {
                renderer = TestRenderer.create(renderControlled(false));
            });
            act(() => renderer.update(renderControlled(true)));
            // Re-render once after the effect so the lightweight Reanimated
            // test double materializes the synchronized shared value.
            act(() => renderer.update(renderControlled(true)));

            const filmstrip = renderer.root.findAllByType('AnimatedView').find((node: any) => (
                Array.isArray(node.props.style)
                && node.props.style.some((style: any) => style?.flexDirection === 'row')
            ));
            expect(filmstrip.props.style).toContainEqual(expect.objectContaining({ width: 400 }));
            expect(filmstrip.props.style).not.toContainEqual(expect.objectContaining({ transform: expect.any(Array) }));
            const main = renderer.root.findByProps({ testID: 'right-swipe-panel-main' });
            const drawer = renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' });
            expect(main.props.style).toEqual(expect.objectContaining({ width: 240 }));
            expect(flattenStyle(drawer.props.style)).toEqual(expect.objectContaining({ width: 160 }));
            expect(drawer.props.accessibilityElementsHidden).toBeUndefined();
            expect(drawer.props.importantForAccessibility).toBeUndefined();
        } finally {
            if (renderer) act(() => renderer.unmount());
            (Platform as { OS: string }).OS = 'ios';
        }
    });

    it('can let a focused detail panel replace the full compact workspace', () => {
        (Platform as { OS: string }).OS = 'web';
        let renderer: any;

        try {
            act(() => {
                renderer = TestRenderer.create(
                    <RightSwipePanelHost
                        {...PANEL_ACCESSIBILITY_LABELS}
                        enabled
                        fullWidth
                        gestureEnabled={false}
                        mode="drawer-toggle"
                        open
                        panelContent={<View />}
                    >
                        <View />
                    </RightSwipePanelHost>,
                );
            });

            const main = renderer.root.findByProps({ testID: 'right-swipe-panel-main' });
            const drawer = renderer.root.findByProps({ testID: 'right-swipe-panel-drawer' });
            const scrim = renderer.root.findByProps({ testID: 'right-swipe-panel-scrim' });
            expect(main.props.style).toEqual(expect.objectContaining({ width: 0 }));
            expect(flattenStyle(drawer.props.style)).toEqual(expect.objectContaining({ width: 400 }));
            expect(flattenStyle(scrim.props.style)).toEqual(expect.objectContaining({ width: 0 }));
        } finally {
            if (renderer) act(() => renderer.unmount());
            (Platform as { OS: string }).OS = 'ios';
        }
    });
});

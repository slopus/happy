import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    return style;
}

function nearestView(instance: any) {
    let node = instance?.parent;
    while (node && node.type !== 'View') node = node.parent;
    return node;
}

function flushMicrotasks(times: number) {
    return new Promise<void>((resolve) => {
        let remaining = times;
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) return resolve();
            queueMicrotask(step);
        };
        queueMicrotask(step);
    });
}

vi.mock('@/components/PopoverBoundary', () => ({
    usePopoverBoundaryRef: () => null,
}));

vi.mock('expo-blur', () => {
    const React = require('react');
    return {
        BlurView: (props: any) => React.createElement('BlurView', props, props.children),
    };
});

vi.mock('@/utils/reactNativeScreensCjs', () => {
    const React = require('react');
    return {
        requireReactNativeScreens: () => ({
            FullWindowOverlay: (props: any) => React.createElement('FullWindowOverlay', props, props.children),
        }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
        StyleSheet: {
            absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

function PopoverChild() {
    return React.createElement('PopoverChild');
}

describe('Popover (native portal)', () => {
    it('renders inline when no OverlayPortalProvider is present', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(100, 100, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    'View',
                    { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { native: { useFullWindowOverlayOnIOS: false } },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                ),
            );
        });

        expect(tree?.root.findByProps({ testID: 'inline-slot' }).findAllByType('PopoverChild' as any).length).toBe(1);
    });

    it('renders into OverlayPortalHost when usePortalOnNative is enabled', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(200, 200, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { native: { useFullWindowOverlayOnIOS: false } },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'host-slot' },
                        React.createElement(OverlayPortalHost),
                    ),
                ),
            );
        });

        expect(tree?.root.findByProps({ testID: 'inline-slot' }).findAllByType('PopoverChild' as any).length).toBe(0);
        expect(tree?.root.findByProps({ testID: 'host-slot' }).findAllByType('PopoverChild' as any).length).toBe(1);

        await act(async () => {
            tree?.update(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inline-slot' },
                        React.createElement(Popover, {
                            open: false,
                            anchorRef,
                            portal: { native: { useFullWindowOverlayOnIOS: false } },
                            backdrop: false,
                            children: () => React.createElement(PopoverChild),
                        }),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'host-slot' },
                        React.createElement(OverlayPortalHost),
                    ),
                ),
            );
        });

        expect(tree?.root.findByProps({ testID: 'host-slot' }).findAllByType('PopoverChild' as any).length).toBe(0);
    });

    it('keeps portal content hidden until it can be positioned (prevents visible jiggle)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(200, 200, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'left',
                        portal: { native: { useFullWindowOverlayOnIOS: false }, anchorAlignVertical: 'center' },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    }),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushMicrotasks(3);
        });

        const childAfterMeasure = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfterMeasure = nearestView(childAfterMeasure);
        expect(flattenStyle(contentViewAfterMeasure?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterMeasure?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const childAfterFirstLayout = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfterFirstLayout = nearestView(childAfterFirstLayout);
        expect(flattenStyle(contentViewAfterFirstLayout?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 120 } } });
        });

        const childAfterLayout = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfterLayout = nearestView(childAfterLayout);
        expect(flattenStyle(contentViewAfterLayout?.props?.style).opacity).toBe(1);
    });

    it('can spotlight the anchor so it stays crisp above the blur', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: { useFullWindowOverlayOnIOS: false } },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', spotlight: true },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const effects = tree?.root.findAllByProps({ testID: 'popover-backdrop-effect' } as any) ?? [];
        // Our native test shims represent `BlurView` as a wrapper component returning a host element,
        // so `findAllByProps` will match both. Filter to host nodes for stable assertions.
        const hostEffects = effects.filter((node: any) => typeof node.type === 'string');
        expect(hostEffects.length).toBe(4);
    });

    it('can render an anchor overlay above the blur backdrop (keeps the trigger crisp without cutout seams)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(140, 120, 28, 28));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: { useFullWindowOverlayOnIOS: false } },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur', anchorOverlay: () => React.createElement('AnchorOverlay') },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const overlays = tree?.root.findAllByProps({ testID: 'popover-anchor-overlay' } as any) ?? [];
        const hostOverlays = overlays.filter((node: any) => typeof node.type === 'string');
        expect(hostOverlays.length).toBe(1);

        const overlayStyle = flattenStyle(hostOverlays[0]?.props?.style);
        expect(overlayStyle.position).toBe('absolute');
        expect(overlayStyle.left).toBe(140);
        expect(overlayStyle.top).toBe(120);
        expect(overlayStyle.width).toBe(28);
        expect(overlayStyle.height).toBe(28);
    });

    it('wraps portal content in FullWindowOverlay that intercepts touches when backdrop is enabled', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        onRequestClose: () => {},
                        backdrop: { effect: 'blur' },
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const overlays = tree?.root.findAllByType('FullWindowOverlay' as any) ?? [];
        expect(overlays.length).toBe(1);
        expect(overlays[0]?.props?.pointerEvents).toBe('auto');
    });

    it('keeps FullWindowOverlay non-interactive when backdrop is disabled', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(Popover, {
                        open: true,
                        anchorRef,
                        placement: 'bottom',
                        portal: { native: true },
                        backdrop: false,
                        children: () => React.createElement(PopoverChild),
                    } as any),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const overlays = tree?.root.findAllByType('FullWindowOverlay' as any) ?? [];
        expect(overlays.length).toBe(1);
        expect(overlays[0]?.props?.pointerEvents).toBe('box-none');
    });
});

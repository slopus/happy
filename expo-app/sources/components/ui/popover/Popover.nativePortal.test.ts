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

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
}));

vi.mock('expo-blur', () => {
    const React = require('react');
    return {
        BlurView: (props: any) => React.createElement('BlurView', props, props.children),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios' },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

function PopoverChild() {
    return React.createElement('PopoverChild');
}

describe('Popover (native portal)', () => {
    it('positions using anchor coordinates relative to the portal root when available (avoids iOS header/sheet offsets)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = { _id: 'portal-root' };

        const anchorRef = {
            current: {
                measureLayout: (relativeTo: any, onSuccess: any) => {
                    // Simulate coordinates relative to the portal root (e.g. inside a screen with a header).
                    if (relativeTo !== portalRootNode) throw new Error('expected measureLayout relativeTo portal root');
                    queueMicrotask(() => onSuccess(10, 20, 30, 40));
                },
                // If Popover mistakenly uses window coords here, it will position incorrectly.
                measureInWindow: (cb: any) => queueMicrotask(() => cb(999, 999, 30, 40)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        PopoverPortalTargetContextProvider,
                        {
                            value: { rootRef: { current: portalRootNode } as any, layout: { width: 390, height: 844 } },
                            children: React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                placement: 'bottom',
                                portal: { native: true },
                                backdrop: false,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        } as any,
                    ),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const container = nearestView(child);
        const style = flattenStyle(container?.props?.style);

        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.left).toBe(10);
        expect(style.top).toBe(68);
        expect(style.width).toBe(30);
    });

    it('does not mix window-relative boundary measurements with portal-root-relative anchor measurements (prevents off-screen menus)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = { _id: 'portal-root' };

        const anchorRef = {
            current: {
                measureLayout: (relativeTo: any, onSuccess: any) => {
                    if (relativeTo !== portalRootNode) throw new Error('expected measureLayout relativeTo portal root');
                    queueMicrotask(() => onSuccess(10, 100, 30, 40));
                },
                measureInWindow: (cb: any) => queueMicrotask(() => cb(999, 999, 30, 40)),
            },
        } as any;

        const boundaryRef = {
            current: {
                // If Popover wrongly uses this window-relative boundary rect while the anchor rect is
                // portal-root-relative, `topForBottom` clamps `top` to boundaryRect.y (off-screen).
                measureInWindow: (cb: any) => queueMicrotask(() => cb(0, 600, 390, 844)),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        PopoverPortalTargetContextProvider,
                        {
                            value: { rootRef: { current: portalRootNode } as any, layout: { width: 0, height: 0 } },
                            children: React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                boundaryRef,
                                placement: 'bottom',
                                portal: { native: true },
                                backdrop: false,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        } as any,
                    ),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const container = nearestView(child);
        const style = flattenStyle(container?.props?.style);

        // placement=bottom => top = y + height + gap (default gap=8)
        expect(style.top).toBe(148);
        expect(style.left).toBe(10);
    });

    it('retries measurement when the initial anchor rect is zero-sized (prevents iOS dropdowns from overlapping the trigger)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');

        const originalRaf = (globalThis as any).requestAnimationFrame;
        (globalThis as any).requestAnimationFrame = (cb: () => void) => {
            cb();
            return 0 as any;
        };

        let measureCalls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    measureCalls += 1;
                    if (measureCalls === 1) {
                        cb(200, 200, 0, 0);
                        return;
                    }
                    cb(200, 200, 20, 20);
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
                    }),
                    React.createElement(OverlayPortalHost),
                ),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        expect(measureCalls).toBeGreaterThanOrEqual(2);

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(1);

        (globalThis as any).requestAnimationFrame = originalRaf;
    });

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
                            portal: { native: true },
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
                            portal: { native: true },
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
                            portal: { native: true },
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
                        portal: { native: true, anchorAlignVertical: 'center' },
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
                        portal: { native: true },
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
                        portal: { native: true },
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

});

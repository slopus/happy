import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('@/utils/web/radixCjs', () => {
    const React = require('react');
    return {
        requireRadixDismissableLayer: () => ({
            Branch: (props: any) => React.createElement('DismissableLayerBranch', props, props.children),
        }),
    };
});

vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: (node: any, target: any) => {
            const React = require('react');
            return React.createElement('Portal', { target }, node);
        },
    }),
}));

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web' },
        useWindowDimensions: () => ({ width: 1000, height: 800 }),
        StyleSheet: {
            absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

describe('Popover (web)', () => {
    beforeEach(() => {
        // Minimal window stubs for node test environment.
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
        });
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
            cb();
            return 0;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the content above the backdrop when not using a portal', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    Popover,
                    {
                        open: true,
                        anchorRef,
                        backdrop: { enabled: true, blockOutsidePointerEvents: true },
                        onRequestClose: () => {},
                        children: () => React.createElement('PopoverChild'),
                    },
                ),
            );
        });

        const pressables = tree?.root.findAllByType('Pressable' as any) ?? [];
        const backdrop = pressables.find((p: any) => flattenStyle(p.props.style).top === 0);
        expect(backdrop).toBeTruthy();
        expect(flattenStyle(backdrop?.props.style).position).toBe('fixed');

        const child = tree?.root.findByType('PopoverChild' as any);
        const content = nearestView(child);
        expect(content).toBeTruthy();

        const backdropZ = flattenStyle(backdrop?.props.style).zIndex;
        const contentZ = flattenStyle(content?.props.style).zIndex;
        expect(typeof backdropZ).toBe('number');
        expect(typeof contentZ).toBe('number');
        expect(contentZ).toBeGreaterThan(backdropZ);
    });

    it('wraps portal-to-body popovers in a Radix DismissableLayer Branch so underlying Vaul/Radix layers don’t treat it as “outside”', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    Popover,
                    {
                        open: true,
                        anchorRef,
                        portal: { web: true },
                        onRequestClose: () => {},
                        children: () => React.createElement('PopoverChild'),
                    },
                ),
            );
        });

        expect(tree?.root.findAllByType('DismissableLayerBranch' as any).length).toBe(1);
    });

    it('portals to a modal portal host when available (prevents Radix Dialog scroll-lock from swallowing wheel/touch scroll)', async () => {
        const { Popover } = await import('./Popover');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');

        const anchorRef = { current: null } as any;
        const modalTarget = {} as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: modalTarget,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ),
            );
        });

        const portal = tree?.root.findAllByType('Portal' as any)?.[0];
        expect(portal).toBeTruthy();
        expect((portal as any)?.props?.target).toBe(modalTarget);
    });

    it('does not subscribe to scroll events when portaling into a modal/boundary target (avoids scroll jank on mobile web)', async () => {
        const { Popover } = await import('./Popover');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');

        const anchorRef = { current: null } as any;
        const modalTarget = {} as any;

        act(() => {
            renderer.create(
                React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: modalTarget,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ),
            );
        });

        const add = (globalThis as any).window?.addEventListener as any;
        const calls = add?.mock?.calls ?? [];
        const events = calls.map((c: any[]) => c?.[0]).filter(Boolean);
        expect(events).toContain('resize');
        expect(events).not.toContain('scroll');
    });

    it('portals to the PopoverBoundary when in an Expo Router modal (prevents Vaul/Radix scroll-lock from swallowing wheel/touch scroll)', async () => {
        const boundaryTarget = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            appendChild: vi.fn(),
        } as any;
        const boundaryRef = { current: boundaryTarget } as any;
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const anchorRef = { current: null } as any;
        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(
                    PopoverBoundaryProvider,
                    {
                        boundaryRef,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            portal: { web: true },
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ),
            );
        });

        const portal = tree?.root.findAllByType('Portal' as any)?.[0];
        expect(portal).toBeTruthy();
        expect((portal as any)?.props?.target).toBe(boundaryTarget);
    });

    it('accounts for portal-target scroll offset when positioning inside a scrollable boundary (prevents dropdowns from drifting upward)', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const boundaryTarget = {
            scrollTop: 400,
            scrollLeft: 0,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            appendChild: vi.fn(),
            getBoundingClientRect: () => ({
                left: 0,
                top: 50,
                width: 1000,
                height: 800,
                x: 0,
                y: 50,
            }),
        } as any;

        const boundaryRef = { current: boundaryTarget } as any;
        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 600,
                    width: 300,
                    height: 40,
                    x: 0,
                    y: 600,
                }),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    PopoverBoundaryProvider,
                    {
                        boundaryRef,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            boundaryRef,
                            portal: { web: { target: 'boundary' } },
                            placement: 'bottom',
                            gap: 0,
                            maxHeightCap: 320,
                            onRequestClose: () => {},
                            children: () => React.createElement('PopoverChild'),
                        }),
                    },
                ),
            );
            await flushMicrotasks(6);
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const content = nearestView(child);
        expect(content).toBeTruthy();

        const style = flattenStyle(content?.props?.style);
        // Desired viewport top is anchorBottom (= 600 + 40) = 640.
        // Portal target top is 50; when positioned absolute inside a scrollable element, the style.top
        // must include scrollTop to avoid being offset by scrolling (640 - 50 + 400 = 990).
        expect(style.top).toBe(990);
    });

    it('stops wheel propagation in portal mode (prevents document-level scroll-lock listeners from breaking popover scrolling)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    portal: { web: true },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const content = nearestView(child);
        expect(content).toBeTruthy();

        const stopPropagation = vi.fn();
        act(() => {
            content?.props?.onWheel?.({ stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('treats boundaryRef={null} as an explicit override (uses viewport fallback even when a PopoverBoundaryProvider is present)', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverBoundaryProvider } = await import('@/components/ui/popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 650,
                    width: 100,
                    height: 40,
                    x: 0,
                    y: 650,
                }),
            },
        } as any;

        const boundaryRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 500,
                    width: 1000,
                    height: 200,
                    x: 0,
                    y: 500,
                }),
            },
        } as any;

        const renders: Array<{ maxHeight: number }> = [];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    PopoverBoundaryProvider,
                    {
                        boundaryRef,
                        children: React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            boundaryRef: null,
                            portal: { web: true },
                            placement: 'top',
                            maxHeightCap: 400,
                            onRequestClose: () => {},
                            children: (renderProps: any) => {
                                renders.push({ maxHeight: renderProps.maxHeight });
                                return React.createElement('PopoverChild');
                            },
                        }),
                    },
                ),
            );
            await flushMicrotasks(6);
        });

        expect(tree).toBeTruthy();
        // With boundaryRef=null, it should ignore the boundary provider and use viewport fallback.
        // Available top is 650 - 0 - 8 = 642, capped by maxHeightCap=400.
        expect(renders.at(-1)?.maxHeight).toBe(400);
    });

	    it('positions top-placed portal popovers using the measured content height (avoids “mid-screen” placement)', async () => {
	        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({
                    left: 0,
                    top: 600,
                    width: 300,
                    height: 40,
                    x: 0,
                    y: 600,
                }),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    portal: { web: true },
                    placement: 'top',
                    gap: 8,
                    maxHeightCap: 400,
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                }),
            );
            await flushMicrotasks(6);
	        });

	        const child = tree?.root.findByType('PopoverChild' as any);
	        expect(child).toBeTruthy();

	        const contentView = tree?.root.findAllByType('View' as any).find((v: any) => typeof v.props.onLayout === 'function');
	        expect(contentView).toBeTruthy();

        // Simulate measuring the popover content.
        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { width: 520, height: 200 } } });
	            await flushMicrotasks(2);
	        });

	        const updatedChild = tree?.root.findByType('PopoverChild' as any);
	        const updatedContent = updatedChild ? nearestView(updatedChild) : undefined;
	        expect(updatedContent).toBeTruthy();

	        const style = flattenStyle(updatedContent?.props?.style);
	        // top should be anchorTop - contentHeight - gap = 600 - 200 - 8 = 392
	        expect(style.top).toBe(392);
	    });

    it('does not attach wheel propagation stoppers when not using a portal', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const content = nearestView(child);
        expect(content).toBeTruthy();
        expect(content?.props?.onWheel).toBeUndefined();
        expect(content?.props?.onTouchMove).toBeUndefined();
    });

    it('keeps portal popovers hidden until the anchor is measured (prevents visible jiggle)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushMicrotasks(3);
        });

        const childAfter = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfter = nearestView(childAfter);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('measures DOM anchors on web when measureInWindow is unavailable (prevents invisible portal popovers)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                getBoundingClientRect: () => ({ left: 120, top: 140, width: 48, height: 22 }),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushMicrotasks(3);
        });

        const childAfter = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfter = nearestView(childAfter);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('falls back to DOM anchors on web when measureInWindow returns invalid values (prevents stuck invisible portal popovers)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(NaN, NaN, NaN, NaN));
                },
                getBoundingClientRect: () => ({ left: 120, top: 140, width: 48, height: 22 }),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushMicrotasks(3);
        });

        const childAfter = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfter = nearestView(childAfter);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('retries measuring portal anchors on web when measureInWindow returns invalid values (prevents needing a resize)', async () => {
        const { Popover } = await import('./Popover');

        let calls = 0;
        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    calls += 1;
                    queueMicrotask(() => {
                        if (calls === 1) return cb(NaN, NaN, NaN, NaN);
                        cb(100, 100, 20, 20);
                    });
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            await flushMicrotasks(6);
        });

        const childAfter = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfter = nearestView(childAfter);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('keeps left/right portal popovers hidden until content layout is known (prevents recenter jiggle)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(200, 200, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'left',
                    portal: {
                        web: true,
                        matchAnchorWidth: false,
                        anchorAlignVertical: 'center',
                    },
                    backdrop: false,
                    children: () => React.createElement('PopoverChild'),
                }),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const child = tree?.root.findByType('PopoverChild' as any);
        const contentView = nearestView(child);
        expect(flattenStyle(contentView?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 0 } } });
        });

        const childAfterFirstLayout = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfterFirstLayout = nearestView(childAfterFirstLayout);
        expect(flattenStyle(contentViewAfterFirstLayout?.props?.style).opacity).toBe(0);

        await act(async () => {
            contentViewAfterFirstLayout?.props?.onLayout?.({ nativeEvent: { layout: { width: 180, height: 120 } } });
        });

        const childAfter = tree?.root.findByType('PopoverChild' as any);
        const contentViewAfter = nearestView(childAfter);
        expect(flattenStyle(contentViewAfter?.props?.style).opacity).toBe(1);
    });

    it('supports a blur backdrop behind the popover content (context-menu focus)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = { current: null } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    onRequestClose: () => {},
                    backdrop: { effect: 'blur' },
                    children: () => React.createElement('PopoverChild'),
                } as any),
            );
        });

        const views = tree?.root.findAllByType('View' as any) ?? [];
        expect(views.some((v: any) => v.props?.testID === 'popover-backdrop-effect')).toBe(true);
    });

    it('allows configuring web blur strength and tint for blur backdrops', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: {
                        effect: 'blur',
                        blurOnWeb: { px: 3, tintColor: 'rgba(255, 255, 255, 0.18)' },
                    },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                } as any),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const effects = tree?.root.findAllByProps({ testID: 'popover-backdrop-effect' } as any) ?? [];
        const hostEffects = effects.filter((node: any) => typeof node.type === 'string');
        expect(hostEffects.length).toBe(1);

        const style = flattenStyle(hostEffects[0]?.props?.style);
        expect(style.backdropFilter).toBe('blur(3px)');
        expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.18)');
    });

    it('can spotlight the anchor so it stays crisp above the blur', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(100, 100, 20, 20));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: true },
                    backdrop: {
                        effect: 'blur',
                        spotlight: true,
                    },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                } as any),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const effects = tree?.root.findAllByProps({ testID: 'popover-backdrop-effect' } as any) ?? [];
        // Our RN-web test shim represents `View` as a wrapper component returning a host element,
        // so `findAllByProps` will match both. Filter to host nodes for stable assertions.
        const hostEffects = effects.filter((node: any) => typeof node.type === 'string');
        expect(hostEffects.length).toBe(4);
    });

    it('can render an anchor overlay above the blur backdrop (keeps the trigger crisp without cutout seams)', async () => {
        const { Popover } = await import('./Popover');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => {
                    queueMicrotask(() => cb(120, 80, 24, 24));
                },
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(Popover, {
                    open: true,
                    anchorRef,
                    placement: 'bottom',
                    portal: { web: { target: 'body' } },
                    backdrop: {
                        effect: 'blur',
                        anchorOverlay: () => React.createElement('AnchorOverlay'),
                    },
                    onRequestClose: () => {},
                    children: () => React.createElement('PopoverChild'),
                } as any),
            );
        });

        await act(async () => {
            await flushMicrotasks(3);
        });

        const overlays = tree?.root.findAllByProps({ testID: 'popover-anchor-overlay' } as any) ?? [];
        const hostOverlays = overlays.filter((node: any) => typeof node.type === 'string');
        expect(hostOverlays.length).toBe(1);

        const overlayStyle = flattenStyle(hostOverlays[0]?.props?.style);
        expect(overlayStyle.position).toBe('fixed');
        expect(overlayStyle.left).toBe(120);
        expect(overlayStyle.top).toBe(80);
        expect(overlayStyle.width).toBe(24);
        expect(overlayStyle.height).toBe(24);
    });
});

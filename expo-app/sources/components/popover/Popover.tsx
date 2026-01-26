import * as React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewProps, type ViewStyle, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { usePopoverBoundaryRef } from '@/components/PopoverBoundary';
import { requireRadixDismissableLayer } from '@/utils/radixCjs';
import { useOverlayPortal } from '@/components/OverlayPortal';
import { useModalPortalTarget } from '@/components/ModalPortalTarget';
import { requireReactDOM } from '@/utils/reactDomCjs';
import { usePopoverPortalTarget } from '@/components/PopoverPortalTarget';

const ViewWithWheel = View as unknown as React.ComponentType<ViewProps & { onWheel?: any }>;

export type PopoverPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';
export type ResolvedPopoverPlacement = Exclude<PopoverPlacement, 'auto'>;
export type PopoverBackdropEffect = 'none' | 'dim' | 'blur';

type WindowRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type PopoverWindowRect = WindowRect;

export type PopoverPortalOptions = Readonly<{
    /**
     * Web only: render the popover in a portal using fixed positioning.
     * Useful when the anchor is inside overflow-clipped containers.
     */
    web?: boolean | Readonly<{ target?: 'body' | 'boundary' | 'modal' }>;
    /**
     * Native only: render the popover in a portal host mounted near the app root.
     * This allows popovers to escape overflow clipping from lists/rows/scrollviews.
     */
    native?: boolean;
    /**
     * When true, the popover width is capped to the anchor width for top/bottom placements.
     * Defaults to true to preserve historical behavior.
     */
    matchAnchorWidth?: boolean;
    /**
     * Horizontal alignment relative to the anchor for top/bottom placements.
     * Defaults to 'start' to preserve historical behavior.
     */
    anchorAlign?: 'start' | 'center' | 'end';
    /**
     * Vertical alignment relative to the anchor for left/right placements.
     * Defaults to 'center' for menus/tooltips.
     */
    anchorAlignVertical?: 'start' | 'center' | 'end';
}>;

export type PopoverBackdropOptions = Readonly<{
    /**
     * Whether to render a full-screen layer behind the popover that intercepts taps.
     * Defaults to true.
     *
     * NOTE: when enabled, `onRequestClose` must be provided (Popover is controlled).
     */
    enabled?: boolean;
    /**
     * When true, blocks interactions outside the popover while it's open.
     *
     * - Web: defaults to `false` (popover behaves like a non-modal menu; outside clicks close it but
     *   still allow the underlying target to receive the event).
     * - Native: defaults to `true` (outside taps are intercepted by a full-screen Pressable).
     */
    blockOutsidePointerEvents?: boolean;
    /** Optional visual effect for the backdrop layer. */
    effect?: PopoverBackdropEffect;
    /**
     * Web-only options for `effect="blur"` (CSS `backdrop-filter`).
     * This does not affect native, where `expo-blur` controls intensity/tint.
     */
    blurOnWeb?: Readonly<{ px?: number; tintColor?: string }>;
    /**
     * When enabled (and when `effect` is `dim|blur`), keeps the anchor area visually “uncovered”
     * by the effect so the trigger stays crisp/visible.
     *
     * This is mainly intended for context-menu style popovers.
     */
    spotlight?: boolean | Readonly<{ padding?: number }>;
    /**
     * When provided (and when `effect` is `dim|blur` in portal mode), renders a visual overlay
     * positioned over the anchor *above* the backdrop effect. This avoids “cutout seams”
     * from spotlight-hole techniques and keeps the trigger crisp.
     *
     * Note: this overlay is visual-only and always uses `pointerEvents="none"`.
     */
    anchorOverlay?: React.ReactNode | ((params: Readonly<{ rect: WindowRect }>) => React.ReactNode);
    /** Extra styles applied to the backdrop layer. */
    style?: StyleProp<ViewStyle>;
    /**
     * When enabled, dragging on the backdrop will close the popover.
     * Useful for context-menu style popovers in scrollable screens.
     */
    closeOnPan?: boolean;
}>;

type PopoverCommonProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    placement?: PopoverPlacement;
    gap?: number;
    maxHeightCap?: number;
    maxWidthCap?: number;
    portal?: PopoverPortalOptions;
    /**
     * Adds padding around the popover content inside the anchored container.
     * This is the easiest way to ensure the popover doesn't sit flush against
     * the anchor/container edges, especially when using `left: 0, right: 0`.
     */
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number }>;
    /** Extra styles applied to the positioned popover container. */
    containerStyle?: StyleProp<ViewStyle>;
    children: (render: PopoverRenderProps) => React.ReactNode;
}>;

type PopoverWithBackdrop = PopoverCommonProps & Readonly<{
    backdrop?: true | PopoverBackdropOptions | undefined;
    onRequestClose: () => void;
}>;

type PopoverWithoutBackdrop = PopoverCommonProps & Readonly<{
    backdrop: false | (PopoverBackdropOptions & Readonly<{ enabled: false }>);
    onRequestClose?: () => void;
}>;

function measureInWindow(node: any): Promise<WindowRect | null> {
    return new Promise(resolve => {
        try {
            if (!node) return resolve(null);

            const measureDomRect = (candidate: any): WindowRect | null => {
                const el: any =
                    typeof candidate?.getBoundingClientRect === 'function'
                        ? candidate
                        : candidate?.getScrollableNode?.();
                if (!el || typeof el.getBoundingClientRect !== 'function') return null;
                const rect = el.getBoundingClientRect();
                const x = rect?.left ?? rect?.x;
                const y = rect?.top ?? rect?.y;
                const width = rect?.width;
                const height = rect?.height;
                if (![x, y, width, height].every(n => Number.isFinite(n))) return null;
                // Treat 0x0 rects as invalid: on iOS (and occasionally RN-web), refs can report 0x0
                // for a frame while layout settles. Using these values causes menus to overlap the
                // trigger and prevents subsequent recomputes from correcting placement.
                if (width <= 0 || height <= 0) return null;
                return { x, y, width, height };
            };

            // On web, prefer DOM measurement. It's synchronous and avoids cases where
            // RN-web's `measureInWindow` returns invalid values or never calls back.
            if (Platform.OS === 'web') {
                const rect = measureDomRect(node);
                if (rect) return resolve(rect);
            }

            // On native, `measure` can provide pageX/pageY values that are sometimes more reliable
            // than `measureInWindow` when using react-native-screens (modal/drawer presentations).
            // Prefer it when available.
            if (Platform.OS !== 'web' && typeof node.measure === 'function') {
                node.measure((x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
                    if (![pageX, pageY, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        return resolve(null);
                    }
                    resolve({ x: pageX, y: pageY, width, height });
                });
                return;
            }

            if (typeof node.measureInWindow === 'function') {
                node.measureInWindow((x: number, y: number, width: number, height: number) => {
                    if (![x, y, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        if (Platform.OS === 'web') {
                            const rect = measureDomRect(node);
                            if (rect) return resolve(rect);
                        }
                        return resolve(null);
                    }
                    resolve({ x, y, width, height });
                });
                return;
            }

            if (Platform.OS === 'web') return resolve(measureDomRect(node));

            resolve(null);
        } catch {
            resolve(null);
        }
    });
}

function measureLayoutRelativeTo(node: any, relativeToNode: any): Promise<WindowRect | null> {
    return new Promise(resolve => {
        try {
            if (!node || !relativeToNode) return resolve(null);
            if (typeof node.measureLayout !== 'function') return resolve(null);
            node.measureLayout(
                relativeToNode,
                (x: number, y: number, width: number, height: number) => {
                    if (![x, y, width, height].every(n => Number.isFinite(n)) || width <= 0 || height <= 0) {
                        resolve(null);
                        return;
                    }
                    resolve({ x, y, width, height });
                },
                () => resolve(null),
            );
        } catch {
            resolve(null);
        }
    });
}

function getFallbackBoundaryRect(params: { windowWidth: number; windowHeight: number }): WindowRect {
    // On native, the "window" coordinate space is the best available fallback.
    // On web, this maps closely to the viewport (measureInWindow is viewport-relative).
    return { x: 0, y: 0, width: params.windowWidth, height: params.windowHeight };
}

function resolvePlacement(params: {
    placement: PopoverPlacement;
    available: Record<ResolvedPopoverPlacement, number>;
}): ResolvedPopoverPlacement {
    if (params.placement !== 'auto') return params.placement;
    const entries = Object.entries(params.available) as Array<[ResolvedPopoverPlacement, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0] ?? 'top';
}

export type PopoverRenderProps = Readonly<{
    maxHeight: number;
    maxWidth: number;
    placement: ResolvedPopoverPlacement;
}>;

export function Popover(props: PopoverWithBackdrop | PopoverWithoutBackdrop) {
    const {
        open,
        anchorRef,
        boundaryRef: boundaryRefProp,
        placement = 'auto',
        gap = 8,
        maxHeightCap = 400,
        maxWidthCap = 520,
        onRequestClose,
        edgePadding = 0,
        backdrop,
        containerStyle,
        children,
    } = props;

    const boundaryFromContext = usePopoverBoundaryRef();
    // `boundaryRef` can be provided explicitly (including `null`) to override any boundary from context.
    // This is useful when a PopoverBoundaryProvider is present (e.g. inside an Expo Router modal) but a
    // particular popover should instead be constrained to the viewport.
    const boundaryRef = boundaryRefProp === undefined ? boundaryFromContext : boundaryRefProp;
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const overlayPortal = useOverlayPortal();
    const modalPortalTarget = useModalPortalTarget();
    const portalTarget = usePopoverPortalTarget();
    const portalWeb = props.portal?.web;
    const portalNative = props.portal?.native;
    const defaultPortalTargetOnWeb: 'body' | 'boundary' | 'modal' =
        modalPortalTarget
            ? 'modal'
            : boundaryRef
                ? 'boundary'
                : 'body';
    const portalTargetOnWeb =
        typeof portalWeb === 'object' && portalWeb
            ? (portalWeb.target ?? defaultPortalTargetOnWeb)
            : defaultPortalTargetOnWeb;
    const matchAnchorWidthOnPortal = props.portal?.matchAnchorWidth ?? true;
    const anchorAlignOnPortal = props.portal?.anchorAlign ?? 'start';
    const anchorAlignVerticalOnPortal = props.portal?.anchorAlignVertical ?? 'center';

    const shouldPortalWeb = Platform.OS === 'web' && Boolean(portalWeb);
    const shouldPortalNative = Platform.OS !== 'web' && Boolean(portalNative) && Boolean(overlayPortal);
    const shouldPortal = shouldPortalWeb || shouldPortalNative;
    const shouldUseOverlayPortalOnNative = shouldPortalNative;
    const portalIdRef = React.useRef<string | null>(null);
    if (portalIdRef.current === null) {
        portalIdRef.current = `popover-${Math.random().toString(36).slice(2)}`;
    }
    const contentContainerRef = React.useRef<any>(null);

    const getDomElementFromNode = React.useCallback((candidate: any): HTMLElement | null => {
        if (!candidate) return null;
        if (typeof candidate.contains === 'function') return candidate as HTMLElement;
        const scrollable = candidate.getScrollableNode?.();
        if (scrollable && typeof scrollable.contains === 'function') return scrollable as HTMLElement;
        return null;
    }, []);

    const getBoundaryDomElement = React.useCallback((): HTMLElement | null => {
        const boundaryNode = boundaryRef?.current as any;
        if (!boundaryNode) return null;
        // Direct DOM element (RN-web View ref often is the DOM element)
        if (typeof boundaryNode.addEventListener === 'function' && typeof boundaryNode.appendChild === 'function') {
            return boundaryNode as HTMLElement;
        }
        // RN ScrollView refs often expose getScrollableNode()
        const scrollable = boundaryNode.getScrollableNode?.();
        if (scrollable && typeof scrollable.addEventListener === 'function' && typeof scrollable.appendChild === 'function') {
            return scrollable as HTMLElement;
        }
        return null;
    }, [boundaryRef]);

    const getWebPortalTarget = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        if (portalTargetOnWeb === 'modal') return (modalPortalTarget as any) ?? null;
        if (portalTargetOnWeb === 'boundary') return getBoundaryDomElement();
        return typeof document !== 'undefined' ? document.body : null;
    }, [getBoundaryDomElement, modalPortalTarget, portalTargetOnWeb]);

    const portalPositionOnWeb: ViewStyle['position'] =
        Platform.OS === 'web' && shouldPortalWeb && portalTargetOnWeb !== 'body'
            ? 'absolute'
            : ('fixed' as any);
    const webPortalTarget = shouldPortalWeb ? getWebPortalTarget() : null;
    const webPortalTargetRect =
        shouldPortalWeb && portalTargetOnWeb !== 'body'
            ? webPortalTarget?.getBoundingClientRect?.() ?? null
            : null;
    // When positioning `absolute` inside a scrollable container, account for its scroll offset.
    // Otherwise, the portal content is shifted by `-scrollTop`/`-scrollLeft` (it appears to drift
    // upward/left as you scroll the boundary). Using (rect - scroll) means later `top - offset`
    // effectively adds scroll back in.
    const portalScrollLeft = portalPositionOnWeb === 'absolute' ? (webPortalTarget as any)?.scrollLeft ?? 0 : 0;
    const portalScrollTop = portalPositionOnWeb === 'absolute' ? (webPortalTarget as any)?.scrollTop ?? 0 : 0;
    const webPortalOffsetX = (webPortalTargetRect?.left ?? webPortalTargetRect?.x ?? 0) - portalScrollLeft;
    const webPortalOffsetY = (webPortalTargetRect?.top ?? webPortalTargetRect?.y ?? 0) - portalScrollTop;

    const [computed, setComputed] = React.useState<PopoverRenderProps>(() => ({
        maxHeight: maxHeightCap,
        maxWidth: maxWidthCap,
        placement: placement === 'auto' ? 'top' : placement,
    }));
    const [anchorRectState, setAnchorRectState] = React.useState<WindowRect | null>(null);
    const [boundaryRectState, setBoundaryRectState] = React.useState<WindowRect | null>(null);
    const [contentRectState, setContentRectState] = React.useState<WindowRect | null>(null);
    const isMountedRef = React.useRef(true);
    React.useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const edgeInsets = React.useMemo(() => {
        const horizontal =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.horizontal ?? 0);
        const vertical =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.vertical ?? 0);

        return { horizontal, vertical };
    }, [edgePadding]);

    const recompute = React.useCallback(async () => {
        if (!open) return;

        const measureOnce = async (): Promise<boolean> => {
            const anchorNode = anchorRef.current as any;
            const boundaryNodeRaw = boundaryRef?.current as any;
            const portalRootNode =
                Platform.OS !== 'web' && shouldPortalNative
                    ? (portalTarget?.rootRef?.current as any)
                    : null;
            // On web, if boundary is a ScrollView ref, measure the real scrollable node to match
            // the element we attach scroll listeners to. This reduces coordinate mismatches.
            const boundaryNode =
                Platform.OS === 'web'
                    ? (boundaryNodeRaw?.getScrollableNode?.() ?? boundaryNodeRaw)
                    : boundaryNodeRaw;

            let anchorRect: WindowRect | null = null;
            let anchorIsPortalRelative = false;

            if (portalRootNode) {
                const relative = await measureLayoutRelativeTo(anchorNode, portalRootNode);
                if (relative) {
                    anchorRect = relative;
                    anchorIsPortalRelative = true;
                }
            }

            if (!anchorRect) {
                anchorRect = await measureInWindow(anchorNode);
            }

            const boundaryRectRaw = await (async () => {
                // IMPORTANT: Keep anchor + boundary in the same coordinate space.
                // If we position using portal-root-relative anchor coords (measureLayout), then using
                // a window-relative boundary (measureInWindow) can clamp the menu off-screen.
                if (portalRootNode && anchorIsPortalRelative) {
                    const relativeBoundary = boundaryNode ? await measureLayoutRelativeTo(boundaryNode, portalRootNode) : null;
                    if (relativeBoundary) return relativeBoundary;

                    const targetLayout = portalTarget?.layout;
                    if (targetLayout && targetLayout.width > 0 && targetLayout.height > 0) {
                        return { x: 0, y: 0, width: targetLayout.width, height: targetLayout.height };
                    }

                    const rootRect = await measureInWindow(portalRootNode);
                    if (rootRect?.width && rootRect?.height) {
                        return { x: 0, y: 0, width: rootRect.width, height: rootRect.height };
                    }

                    return null;
                }

                if (portalRootNode) {
                    const relativeBoundary = boundaryNode ? await measureLayoutRelativeTo(boundaryNode, portalRootNode) : null;
                    if (relativeBoundary) return relativeBoundary;
                    const targetLayout = portalTarget?.layout;
                    if (targetLayout && targetLayout.width > 0 && targetLayout.height > 0) {
                        return { x: 0, y: 0, width: targetLayout.width, height: targetLayout.height };
                    }
                }

                return boundaryNode ? measureInWindow(boundaryNode) : Promise.resolve(null);
            })();

            if (!isMountedRef.current) return false;
            if (!anchorRect) return false;
            // When portaling (web/native), a zero-sized anchor can cause the popover to render in
            // the wrong place (often overlapping the trigger). Treat it as an invalid measurement
            // and retry a couple times to allow layout to settle.
            if ((shouldPortalWeb || shouldPortalNative) && (anchorRect.width < 1 || anchorRect.height < 1)) {
                return false;
            }

            const boundaryRect =
                boundaryRectRaw ??
                (portalRootNode && portalTarget?.layout?.width && portalTarget?.layout?.height
                    ? { x: 0, y: 0, width: portalTarget.layout.width, height: portalTarget.layout.height }
                    : getFallbackBoundaryRect({ windowWidth, windowHeight }));

            // Shrink the usable boundary so the popover doesn't sit flush to the container edges.
            // (This also makes maxHeight/maxWidth clamping respect the margin.)
            const effectiveBoundaryRect: WindowRect = {
                x: boundaryRect.x + edgeInsets.horizontal,
                y: boundaryRect.y + edgeInsets.vertical,
                width: Math.max(0, boundaryRect.width - edgeInsets.horizontal * 2),
                height: Math.max(0, boundaryRect.height - edgeInsets.vertical * 2),
            };

            const availableTop = (anchorRect.y - effectiveBoundaryRect.y) - gap;
            const availableBottom = (effectiveBoundaryRect.y + effectiveBoundaryRect.height - (anchorRect.y + anchorRect.height)) - gap;
            const availableLeft = (anchorRect.x - effectiveBoundaryRect.x) - gap;
            const availableRight = (effectiveBoundaryRect.x + effectiveBoundaryRect.width - (anchorRect.x + anchorRect.width)) - gap;

            const resolvedPlacement = resolvePlacement({
                placement,
                available: {
                    top: availableTop,
                    bottom: availableBottom,
                    left: availableLeft,
                    right: availableRight,
                },
            });

            const maxHeightAvailable =
                resolvedPlacement === 'bottom'
                    ? availableBottom
                    : resolvedPlacement === 'top'
                        ? availableTop
                        : effectiveBoundaryRect.height - gap * 2;

            const maxWidthAvailable =
                resolvedPlacement === 'right'
                    ? availableRight
                    : resolvedPlacement === 'left'
                        ? availableLeft
                        : effectiveBoundaryRect.width - gap * 2;

            setComputed({
                placement: resolvedPlacement,
                maxHeight: Math.max(0, Math.min(maxHeightCap, Math.floor(maxHeightAvailable))),
                maxWidth: Math.max(0, Math.min(maxWidthCap, Math.floor(maxWidthAvailable))),
            });
            setAnchorRectState(anchorRect);
            setBoundaryRectState(effectiveBoundaryRect);
            return true;
        };

        const scheduleFrame = (cb: () => void) => {
            // In some test/non-browser environments, rAF may be missing.
            // Prefer rAF when available so layout has a chance to settle.
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(cb);
                return;
            }
            if (typeof queueMicrotask === 'function') {
                queueMicrotask(cb);
                return;
            }
            setTimeout(cb, 0);
        };

        const shouldRetry = Platform.OS === 'web' || shouldPortalNative;
        if (!shouldRetry) {
            void measureOnce();
            return;
        }

        // On web and native portal overlays, layout can "settle" a frame later (especially when opening).
        // If the initial measurement returns invalid values, retry a couple times so we don't get stuck
        // with incorrect placement or invisible portal content.
        const measureWithRetries = async (attempt: number) => {
            const ok = await measureOnce();
            if (ok) return;
            if (!isMountedRef.current) return;
            if (attempt >= 2) return;
            scheduleFrame(() => {
                void measureWithRetries(attempt + 1);
            });
        };

        scheduleFrame(() => {
            void measureWithRetries(0);
        });
    }, [anchorRef, boundaryRef, edgeInsets.horizontal, edgeInsets.vertical, gap, maxHeightCap, maxWidthCap, open, placement, shouldPortalNative, shouldPortalWeb, windowHeight, windowWidth, portalTarget]);

    React.useLayoutEffect(() => {
        if (!open) return;
        recompute();
    }, [open, recompute]);

    React.useEffect(() => {
        if (!open) return;
        if (Platform.OS !== 'web') return;

        let timer: number | null = null;
        const debounceMs = 90;

        const schedule = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                recompute();
            }, debounceMs);
        };

        window.addEventListener('resize', schedule);

        // Only subscribe to scroll events when we portal to `document.body` (fixed positioning).
        // For portals mounted inside the modal/boundary target (absolute positioning), the popover
        // is positioned in the same scroll coordinate space as its anchor, so it stays aligned
        // without recomputing on every scroll (avoids scroll jank on mobile web).
        const shouldSubscribeToScroll = shouldPortalWeb && portalTargetOnWeb === 'body';
        const boundaryEl = shouldSubscribeToScroll ? getBoundaryDomElement() : null;
        if (shouldSubscribeToScroll) {
            // Window scroll covers page-level scrolling, but RN-web ScrollViews scroll their own
            // internal div. Subscribe to both so fixed-position popovers track their anchor.
            window.addEventListener('scroll', schedule, { passive: true } as any);
            if (boundaryEl) {
                boundaryEl.addEventListener('scroll', schedule, { passive: true } as any);
            }
        }
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            window.removeEventListener('resize', schedule);
            if (shouldSubscribeToScroll) {
                window.removeEventListener('scroll', schedule as any);
                if (boundaryEl) {
                    boundaryEl.removeEventListener('scroll', schedule as any);
                }
            }
        };
    }, [getBoundaryDomElement, open, portalTargetOnWeb, recompute, shouldPortalWeb]);

    const fixedPositionOnWeb = (Platform.OS === 'web' ? ('fixed' as any) : 'absolute') as ViewStyle['position'];

    const placementStyle: ViewStyle = (() => {
        // On web, optional: render as a viewport-fixed overlay so it can escape any overflow:hidden ancestors.
        // This is especially important for headers/sidebars which often clip overflow.
        if (shouldPortal && anchorRectState) {
            const boundaryRect = boundaryRectState ?? getFallbackBoundaryRect({ windowWidth, windowHeight });
            const position = Platform.OS === 'web' && shouldPortalWeb ? portalPositionOnWeb : fixedPositionOnWeb;
            const desiredWidth = (() => {
                // Preserve historical sizing: for top/bottom, the popover was anchored to the
                // container width (left:0,right:0) and capped by maxWidth. The closest equivalent
                // in portal+fixed mode is to optionally cap width to anchor width.
                if (computed.placement === 'top' || computed.placement === 'bottom') {
                    return matchAnchorWidthOnPortal
                        ? Math.min(computed.maxWidth, Math.floor(anchorRectState.width))
                        : computed.maxWidth;
                }
                // For left/right, menus are typically content-sized; use computed maxWidth.
                return computed.maxWidth;
            })();

            const left = (() => {
                if (computed.placement === 'left') {
                    return anchorRectState.x - gap - desiredWidth;
                }
                if (computed.placement === 'right') {
                    return anchorRectState.x + anchorRectState.width + gap;
                }
                // top/bottom
                const desiredLeftRaw = (() => {
                    switch (anchorAlignOnPortal) {
                        case 'end':
                            return anchorRectState.x + anchorRectState.width - desiredWidth;
                        case 'center':
                            return anchorRectState.x + (anchorRectState.width - desiredWidth) / 2;
                        case 'start':
                        default:
                            return anchorRectState.x;
                    }
                })();
                return desiredLeftRaw;
            })();

            const top = (() => {
                if (computed.placement === 'left' || computed.placement === 'right') {
                    const contentHeight = contentRectState?.height ?? computed.maxHeight;
                    const desiredTopRaw = (() => {
                        switch (anchorAlignVerticalOnPortal) {
                            case 'end':
                                return anchorRectState.y + anchorRectState.height - contentHeight;
                            case 'start':
                                return anchorRectState.y;
                            case 'center':
                            default:
                                return anchorRectState.y + (anchorRectState.height - contentHeight) / 2;
                        }
                    })();

                    return Math.min(
                        boundaryRect.y + boundaryRect.height - contentHeight,
                        Math.max(boundaryRect.y, desiredTopRaw),
                    );
                }

                // top/bottom
                const contentHeight = contentRectState?.height ?? computed.maxHeight;
                const topForBottom = Math.min(
                    boundaryRect.y + boundaryRect.height - contentHeight,
                    Math.max(boundaryRect.y, anchorRectState.y + anchorRectState.height + gap),
                );
                const topForTop = Math.max(
                    boundaryRect.y,
                    Math.min(boundaryRect.y + boundaryRect.height - contentHeight, anchorRectState.y - contentHeight - gap),
                );
                return computed.placement === 'top' ? topForTop : topForBottom;
            })();

            const clampedLeft = Math.min(
                boundaryRect.x + boundaryRect.width - desiredWidth,
                Math.max(boundaryRect.x, left),
            );

            return {
                position,
                left: Math.floor(clampedLeft - (position === 'absolute' ? webPortalOffsetX : 0)),
                top: Math.floor(top - (position === 'absolute' ? webPortalOffsetY : 0)),
                zIndex: 1000,
                width:
                    computed.placement === 'top' ||
                    computed.placement === 'bottom' ||
                    computed.placement === 'left' ||
                    computed.placement === 'right'
                        ? desiredWidth
                        : undefined,
            };
        }

        switch (computed.placement) {
            case 'top':
                return { position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: gap, zIndex: 1000 };
            case 'bottom':
                return { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: gap, zIndex: 1000 };
            case 'left':
                return { position: 'absolute', right: '100%', top: 0, marginRight: gap, zIndex: 1000 };
            case 'right':
                return { position: 'absolute', left: '100%', top: 0, marginLeft: gap, zIndex: 1000 };
        }
    })();

    const portalOpacity = (() => {
        // Web portal popovers should not "jiggle" (render in one place then snap).
        // Hide them until we have enough layout info to position them correctly.
        if (!shouldPortalWeb && !shouldPortalNative) return 1;
        if (!anchorRectState) return 0;
        if (
            (computed.placement === 'left' || computed.placement === 'right') &&
            anchorAlignVerticalOnPortal !== 'start' &&
            (!contentRectState || contentRectState.height < 1)
        ) {
            return 0;
        }
        return 1;
    })();

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside portaled popovers.
        // Stopping propagation here keeps the event within the popover subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (!shouldPortalWeb) return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, [shouldPortalWeb]);

    // IMPORTANT: hooks must not be conditional. This must run even when `open === false`
    // to avoid changing hook order between renders.
    const paddingStyle = React.useMemo<ViewStyle>(() => {
        const horizontal =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.horizontal ?? 0);
        const vertical =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.vertical ?? 0);

        if (computed.placement === 'top' || computed.placement === 'bottom') {
            return horizontal > 0 ? { paddingHorizontal: horizontal } : {};
        }
        if (computed.placement === 'left' || computed.placement === 'right') {
            return vertical > 0 ? { paddingVertical: vertical } : {};
        }
        return {};
    }, [computed.placement, edgePadding]);

    // Must be above BaseModal (100000) and other header overlays.
    const portalZ = 200000;

    const backdropEnabled =
        typeof backdrop === 'boolean'
            ? backdrop
            : (backdrop?.enabled ?? true);
    const backdropBlocksOutsidePointerEvents =
        typeof backdrop === 'object' && backdrop
            ? (backdrop.blockOutsidePointerEvents ?? (Platform.OS === 'web' ? false : true))
            : (Platform.OS === 'web' ? false : true);
    const backdropEffect: PopoverBackdropEffect =
        typeof backdrop === 'object' && backdrop
            ? (backdrop.effect ?? 'none')
            : 'none';
    const backdropBlurOnWeb = typeof backdrop === 'object' && backdrop ? backdrop.blurOnWeb : undefined;
    const backdropSpotlight = typeof backdrop === 'object' && backdrop ? (backdrop.spotlight ?? false) : false;
    const backdropAnchorOverlay = typeof backdrop === 'object' && backdrop ? backdrop.anchorOverlay : undefined;
    const backdropStyle = typeof backdrop === 'object' && backdrop ? backdrop.style : undefined;
    const closeOnBackdropPan = typeof backdrop === 'object' && backdrop ? (backdrop.closeOnPan ?? false) : false;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!open) return;
        if (!onRequestClose) return;
        if (backdropEnabled && backdropBlocksOutsidePointerEvents) return;
        if (typeof document === 'undefined') return;

        const handlePointerDownCapture = (event: Event) => {
            const target = event.target as Node | null;
            if (!target) return;
            const contentEl = getDomElementFromNode(contentContainerRef.current);
            if (contentEl && contentEl.contains(target)) return;
            const anchorEl = getDomElementFromNode(anchorRef.current);
            if (anchorEl && anchorEl.contains(target)) return;
            onRequestClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onRequestClose();
            }
        };

        document.addEventListener('pointerdown', handlePointerDownCapture, true);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDownCapture, true);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [
        anchorRef,
        backdropBlocksOutsidePointerEvents,
        backdropEnabled,
        getDomElementFromNode,
        onRequestClose,
        open,
    ]);

    const content = open ? (
        <>
            {backdropEnabled && backdropEffect !== 'none' ? (() => {
                // On web, use fixed positioning even when not in portal mode to avoid contributing
                // to scrollHeight/scrollWidth (e.g. inside Radix Dialog/Expo Router modals).
                const position =
                    Platform.OS === 'web' && shouldPortalWeb
                        ? portalPositionOnWeb
                        : fixedPositionOnWeb;
                const zIndex = shouldPortal ? portalZ : 998;
                const edge = Platform.OS === 'web' ? 0 : (shouldPortal ? 0 : -1000);

                const fullScreenStyle = [
                    StyleSheet.absoluteFill,
                    {
                        position,
                        top: position === 'absolute' ? 0 : edge,
                        left: position === 'absolute' ? 0 : edge,
                        right: position === 'absolute' ? 0 : edge,
                        bottom: position === 'absolute' ? 0 : edge,
                        opacity: portalOpacity,
                        zIndex,
                    } as const,
                ];

                const spotlightPadding = (() => {
                    if (!backdropSpotlight) return 0;
                    if (backdropSpotlight === true) return 8;
                    const candidate = backdropSpotlight.padding;
                    return typeof candidate === 'number' ? candidate : 8;
                })();

                const spotlightStyles = (() => {
                    if (!shouldPortal) return null;
                    if (!anchorRectState) return null;
                    if (!backdropSpotlight) return null;

                    const offsetX = position === 'absolute' ? webPortalOffsetX : 0;
                    const offsetY = position === 'absolute' ? webPortalOffsetY : 0;

                    const left = Math.max(0, Math.floor(anchorRectState.x - spotlightPadding - offsetX));
                    const top = Math.max(0, Math.floor(anchorRectState.y - spotlightPadding - offsetY));
                    const right = Math.min(windowWidth, Math.ceil(anchorRectState.x + anchorRectState.width + spotlightPadding - offsetX));
                    const bottom = Math.min(windowHeight, Math.ceil(anchorRectState.y + anchorRectState.height + spotlightPadding - offsetY));

                    const holeHeight = Math.max(0, bottom - top);

                    const base: ViewStyle = {
                        position,
                        opacity: portalOpacity,
                        zIndex,
                    };

                    return [
                        // top
                        [{ ...base, top: 0, left: 0, right: 0, height: top }],
                        // bottom
                        [{ ...base, top: bottom, left: 0, right: 0, bottom: 0 }],
                        // left
                        [{ ...base, top, left: 0, width: left, height: holeHeight }],
                        // right
                        [{ ...base, top, left: right, right: 0, height: holeHeight }],
                    ] as const;
                })();

                const effectStyles = spotlightStyles ?? [fullScreenStyle];

                if (backdropEffect === 'blur') {
                    const webBlurPx = typeof backdropBlurOnWeb?.px === 'number' ? backdropBlurOnWeb.px : 12;
                    const webBlurTint = backdropBlurOnWeb?.tintColor ?? 'rgba(0,0,0,0.10)';
                    if (Platform.OS !== 'web') {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-var-requires
                            const { BlurView } = require('expo-blur');
                            if (BlurView) {
                                return (
                                    <>
                                        {effectStyles.map((style, index) => (
                                            <BlurView
                                                // eslint-disable-next-line react/no-array-index-key
                                                key={index}
                                                testID="popover-backdrop-effect"
                                                intensity={Platform.OS === 'ios' ? 12 : 3}
                                                tint="default"
                                                pointerEvents="none"
                                                style={style}
                                            />
                                        ))}
                                    </>
                                );
                            }
                        } catch {
                            // fall through to dim fallback
                        }
                    }

                    return (
                        <>
                            {effectStyles.map((style, index) => (
                                <View
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={index}
                                    testID="popover-backdrop-effect"
                                    pointerEvents="none"
                                        style={[
                                            style,
                                            Platform.OS === 'web'
                                            ? ({ backdropFilter: `blur(${webBlurPx}px)`, backgroundColor: webBlurTint } as any)
                                            : ({ backgroundColor: 'rgba(0,0,0,0.08)' } as any),
                                    ]}
                                />
                            ))}
                        </>
                    );
                }

                // dim
                return (
                    <>
                        {effectStyles.map((style, index) => (
                            <View
                                // eslint-disable-next-line react/no-array-index-key
                                key={index}
                                testID="popover-backdrop-effect"
                                pointerEvents="none"
                                style={[
                                    style,
                                    { backgroundColor: 'rgba(0,0,0,0.08)' },
                                ]}
                            />
                        ))}
                    </>
                );
            })() : null}

            {backdropEnabled && backdropBlocksOutsidePointerEvents ? (
                <Pressable
                    onPress={onRequestClose}
                    pointerEvents={portalOpacity === 0 ? 'none' : 'auto'}
                    onMoveShouldSetResponderCapture={() => {
                        if (!closeOnBackdropPan || !onRequestClose) return false;
                        onRequestClose();
                        return false;
                    }}
                    style={[
                        // Default is deliberately "oversized" so it can capture taps outside the anchor area.
                        {
                            position: fixedPositionOnWeb,
                            top: Platform.OS === 'web' ? 0 : (shouldPortal ? 0 : -1000),
                            left: Platform.OS === 'web' ? 0 : (shouldPortal ? 0 : -1000),
                            right: Platform.OS === 'web' ? 0 : (shouldPortal ? 0 : -1000),
                            bottom: Platform.OS === 'web' ? 0 : (shouldPortal ? 0 : -1000),
                            opacity: portalOpacity,
                            zIndex: shouldPortal ? portalZ : 999,
                        },
                        backdropStyle,
                    ]}
                />
            ) : null}

            {shouldPortal && backdropEnabled && backdropEffect !== 'none' && backdropAnchorOverlay && anchorRectState ? (
                <View
                    testID="popover-anchor-overlay"
                    pointerEvents="none"
                    style={[
                        {
                            position: shouldPortalWeb ? portalPositionOnWeb : 'absolute',
                            left: (() => {
                                const offsetX = portalPositionOnWeb === 'absolute' ? webPortalOffsetX : 0;
                                return Math.max(0, Math.floor(anchorRectState.x - offsetX));
                            })(),
                            top: (() => {
                                const offsetY = portalPositionOnWeb === 'absolute' ? webPortalOffsetY : 0;
                                return Math.max(0, Math.floor(anchorRectState.y - offsetY));
                            })(),
                            width: (() => {
                                const offsetX = portalPositionOnWeb === 'absolute' ? webPortalOffsetX : 0;
                                const left = Math.max(0, Math.floor(anchorRectState.x - offsetX));
                                return Math.max(0, Math.min(windowWidth - left, Math.ceil(anchorRectState.width)));
                            })(),
                            height: (() => {
                                const offsetY = portalPositionOnWeb === 'absolute' ? webPortalOffsetY : 0;
                                const top = Math.max(0, Math.floor(anchorRectState.y - offsetY));
                                return Math.max(0, Math.min(windowHeight - top, Math.ceil(anchorRectState.height)));
                            })(),
                            opacity: portalOpacity,
                            zIndex: portalZ + 1,
                        } as const,
                    ]}
                >
                    {typeof backdropAnchorOverlay === 'function'
                        ? backdropAnchorOverlay({ rect: anchorRectState })
                        : backdropAnchorOverlay}
                </View>
            ) : null}
            <ViewWithWheel
                ref={contentContainerRef}
                {...(shouldPortalWeb
                    ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                    : {})}
                style={[
                    placementStyle,
                    paddingStyle,
                    containerStyle,
                    { maxWidth: computed.maxWidth },
                    (shouldPortalWeb || shouldPortalNative) ? { opacity: portalOpacity } : null,
                    shouldPortal ? { zIndex: portalZ + 1 } : null,
                ]}
                pointerEvents={(shouldPortalWeb || shouldPortalNative) && portalOpacity === 0 ? 'none' : 'auto'}
                onLayout={(e) => {
                    // Used to improve portal alignment (especially left/right centering)
                    const layout = e?.nativeEvent?.layout;
                    if (!layout) return;
                    const next = { x: 0, y: 0, width: layout.width ?? 0, height: layout.height ?? 0 };
                    // Avoid rerender loops from tiny float changes
                    setContentRectState((prev) => {
                        if (!prev) return next;
                        if (Math.abs(prev.width - next.width) > 1 || Math.abs(prev.height - next.height) > 1) {
                            return next;
                        }
                        return prev;
                    });
                }}
            >
                {children(computed)}
            </ViewWithWheel>
        </>
    ) : null;

    const contentWithRadixBranch = (() => {
        if (!content) return null;
        if (!shouldPortalWeb) return content;
        try {
            // IMPORTANT:
            // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer stacks)
            // are shared with Vaul / expo-router on web. Without this, "outside click" logic
            // can treat portaled popovers as outside the active modal.
            const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();
            return (
                <DismissableLayerBranch>
                    {content}
                </DismissableLayerBranch>
            );
        } catch {
            return content;
        }
    })();

    React.useLayoutEffect(() => {
        if (!overlayPortal) return;
        const id = portalIdRef.current as string;
        if (!shouldUseOverlayPortalOnNative || !content) {
            overlayPortal.removePortalNode(id);
            return;
        }
        overlayPortal.setPortalNode(id, content);
        return () => {
            overlayPortal.removePortalNode(id);
        };
    }, [content, overlayPortal, shouldUseOverlayPortalOnNative]);

    if (!open) return null;

    if (shouldPortalWeb) {
        try {
            // Avoid importing react-dom on native.
            const ReactDOM = requireReactDOM();
            const boundaryEl = getBoundaryDomElement();
            const targetRequested =
                portalTargetOnWeb === 'modal'
                    ? modalPortalTarget
                    : portalTargetOnWeb === 'boundary'
                    ? boundaryEl
                    : (typeof document !== 'undefined' ? document.body : null);
            // Fallback: if the requested boundary isn't a DOM node, fall back to body
            const target =
                targetRequested ??
                (typeof document !== 'undefined' ? document.body : null);
            if (target && ReactDOM?.createPortal) {
                return ReactDOM.createPortal(contentWithRadixBranch, target);
            }
        } catch {
            // fall back to inline render
        }
    }

    if (shouldUseOverlayPortalOnNative) return null;
    return contentWithRadixBranch;
}

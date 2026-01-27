import * as React from 'react';
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle, useWindowDimensions } from 'react-native';
import { usePopoverBoundaryRef } from './PopoverBoundary';
import { requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { useOverlayPortal } from './OverlayPortal';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { usePopoverPortalTarget } from './PopoverPortalTarget';
import type {
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';
import { getFallbackBoundaryRect, measureInWindow, measureLayoutRelativeTo } from './measure';
import { resolvePlacement } from './positioning';
import { PopoverBackdrop } from './backdrop';
import { tryRenderWebPortal, useNativeOverlayPortalNode } from './portal';

const ViewWithWheel = View as unknown as React.ComponentType<ViewProps & { onWheel?: any }>;

export type {
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';

type WindowRect = PopoverWindowRect;

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
            <PopoverBackdrop
                backdrop={backdropEnabled ? backdrop : false}
                backdropBlocksOutsidePointerEvents={backdropBlocksOutsidePointerEvents}
                backdropEffect={backdropEffect}
                backdropBlurOnWeb={backdropBlurOnWeb}
                backdropSpotlight={backdropSpotlight}
                backdropAnchorOverlay={backdropAnchorOverlay}
                backdropStyle={backdropStyle}
                closeOnBackdropPan={closeOnBackdropPan}
                onRequestClose={onRequestClose}
                shouldPortal={shouldPortal}
                shouldPortalWeb={shouldPortalWeb}
                portal={props.portal}
                portalOpacity={portalOpacity}
                portalPositionOnWeb={portalPositionOnWeb}
                fixedPositionOnWeb={fixedPositionOnWeb}
                portalZ={portalZ}
                anchorRect={anchorRectState}
                windowWidth={windowWidth}
                windowHeight={windowHeight}
                webPortalOffsetX={webPortalOffsetX}
                webPortalOffsetY={webPortalOffsetY}
            />
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

    useNativeOverlayPortalNode({
        overlayPortal,
        portalId: portalIdRef.current as string,
        enabled: shouldUseOverlayPortalOnNative,
        content,
    });

    if (!open) return null;

    const webPortal = tryRenderWebPortal({
        shouldPortalWeb,
        portalTargetOnWeb,
        modalPortalTarget: (modalPortalTarget as any) ?? null,
        getBoundaryDomElement,
        content: contentWithRadixBranch,
    });
    if (webPortal) return webPortal;

    if (shouldUseOverlayPortalOnNative) return null;
    return contentWithRadixBranch;
}

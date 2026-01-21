import * as React from 'react';

export type ScrollEdge = 'top' | 'bottom' | 'left' | 'right';

export type ScrollEdgeVisibility = Readonly<{
    top: boolean;
    bottom: boolean;
    left: boolean;
    right: boolean;
}>;

export type UseScrollEdgeFadesParams = Readonly<{
    enabledEdges: Partial<Record<ScrollEdge, boolean>>;
    /**
     * Minimum overflow (content - viewport) before we consider scrolling possible.
     * Helps avoid flicker from 0-1px rounding differences.
     */
    overflowThreshold?: number;
    /**
     * Distance from the edge before we show the fade (px).
     */
    edgeThreshold?: number;
}>;

type Size = Readonly<{ width: number; height: number }>;
type Offset = Readonly<{ x: number; y: number }>;

const defaultVisibility: ScrollEdgeVisibility = Object.freeze({
    top: false,
    bottom: false,
    left: false,
    right: false,
});

export function useScrollEdgeFades(params: UseScrollEdgeFadesParams) {
    const overflowThreshold = params.overflowThreshold ?? 1;
    const edgeThreshold = params.edgeThreshold ?? 1;

    const enabled = React.useMemo(() => {
        return {
            top: Boolean(params.enabledEdges.top),
            bottom: Boolean(params.enabledEdges.bottom),
            left: Boolean(params.enabledEdges.left),
            right: Boolean(params.enabledEdges.right),
        };
    }, [params.enabledEdges.bottom, params.enabledEdges.left, params.enabledEdges.right, params.enabledEdges.top]);

    const viewportRef = React.useRef<Size>({ width: 0, height: 0 });
    const contentRef = React.useRef<Size>({ width: 0, height: 0 });
    const offsetRef = React.useRef<Offset>({ x: 0, y: 0 });

    const [canScroll, setCanScroll] = React.useState(() => ({ x: false, y: false }));

    const visibilityRef = React.useRef<ScrollEdgeVisibility>(defaultVisibility);
    const [visibility, setVisibility] = React.useState<ScrollEdgeVisibility>(defaultVisibility);

    const recompute = React.useCallback(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        const offset = offsetRef.current;

        const canScrollX = content.width > viewport.width + overflowThreshold;
        const canScrollY = content.height > viewport.height + overflowThreshold;

        const top = enabled.top && canScrollY && offset.y > edgeThreshold;
        const bottom =
            enabled.bottom &&
            canScrollY &&
            (offset.y + viewport.height) < (content.height - edgeThreshold);

        const left = enabled.left && canScrollX && offset.x > edgeThreshold;
        const right =
            enabled.right &&
            canScrollX &&
            (offset.x + viewport.width) < (content.width - edgeThreshold);

        const nextVisibility: ScrollEdgeVisibility = { top, bottom, left, right };

        const prevVisibility = visibilityRef.current;
        if (
            prevVisibility.top !== nextVisibility.top ||
            prevVisibility.bottom !== nextVisibility.bottom ||
            prevVisibility.left !== nextVisibility.left ||
            prevVisibility.right !== nextVisibility.right
        ) {
            visibilityRef.current = nextVisibility;
            setVisibility(nextVisibility);
        }

        setCanScroll(prev => {
            if (prev.x === canScrollX && prev.y === canScrollY) return prev;
            return { x: canScrollX, y: canScrollY };
        });
    }, [edgeThreshold, enabled.bottom, enabled.left, enabled.right, enabled.top, overflowThreshold]);

    const onViewportLayout = React.useCallback((e: any) => {
        const width = e?.nativeEvent?.layout?.width ?? 0;
        const height = e?.nativeEvent?.layout?.height ?? 0;
        viewportRef.current = { width, height };
        recompute();
    }, [recompute]);

    const onContentSizeChange = React.useCallback((width: number, height: number) => {
        contentRef.current = { width, height };
        recompute();
    }, [recompute]);

    const onScroll = React.useCallback((e: any) => {
        const ne = e?.nativeEvent;
        if (!ne) return;

        const x = ne.contentOffset?.x ?? 0;
        const y = ne.contentOffset?.y ?? 0;

        // Prefer event-provided sizes (more accurate during momentum scroll),
        // but keep refs updated too.
        const vw = ne.layoutMeasurement?.width;
        const vh = ne.layoutMeasurement?.height;
        const cw = ne.contentSize?.width;
        const ch = ne.contentSize?.height;

        offsetRef.current = { x, y };

        if (typeof vw === 'number' && typeof vh === 'number') {
            viewportRef.current = { width: vw, height: vh };
        }
        if (typeof cw === 'number' && typeof ch === 'number') {
            contentRef.current = { width: cw, height: ch };
        }

        recompute();
    }, [recompute]);

    return {
        canScrollX: canScroll.x,
        canScrollY: canScroll.y,
        visibility,
        onViewportLayout,
        onContentSizeChange,
        onScroll,
    } as const;
}


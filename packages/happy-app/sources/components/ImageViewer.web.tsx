/**
 * Fullscreen, zoomable image viewer (web).
 *
 * Native gesture-handler/reanimated pinch doesn't map cleanly to mouse/trackpad,
 * so the web build uses DOM directly: wheel-zoom toward the cursor, drag-to-pan
 * when zoomed, double-click to toggle zoom, Esc / × to close. Metro resolves this
 * file in place of `ImageViewer.tsx` on web.
 */
import * as React from 'react';
import { useWindowDimensions } from 'react-native';

const MAX_SCALE = 6;
const DOUBLE_CLICK_SCALE = 2.5;

interface ImageViewerProps {
    uri: string;
    onClose: () => void;
}

export function ImageViewer({ uri, onClose }: ImageViewerProps) {
    const { width, height } = useWindowDimensions();
    const [scale, setScale] = React.useState(1);
    const [tx, setTx] = React.useState(0);
    const [ty, setTy] = React.useState(0);

    const containerRef = React.useRef<HTMLDivElement>(null);
    const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
    // Mirror live state for the imperative wheel listener (registered once).
    const stateRef = React.useRef({ scale, tx, ty });
    stateRef.current = { scale, tx, ty };

    const clampT = React.useCallback((v: number, s: number, dim: number) => {
        const max = (dim * (s - 1)) / 2;
        return Math.min(max, Math.max(-max, v));
    }, []);

    // Zoom to `nextScale` keeping the point (cx, cy) — container-relative px —
    // anchored under the cursor.
    const applyZoom = React.useCallback((nextScale: number, cx: number, cy: number) => {
        const { scale: s, tx: curTx, ty: curTy } = stateRef.current;
        const s2 = Math.min(MAX_SCALE, Math.max(1, nextScale));
        const px = cx - width / 2;
        const py = cy - height / 2;
        let nTx = px - (px - curTx) * (s2 / s);
        let nTy = py - (py - curTy) * (s2 / s);
        if (s2 <= 1) {
            nTx = 0;
            nTy = 0;
        } else {
            nTx = clampT(nTx, s2, width);
            nTy = clampT(nTy, s2, height);
        }
        setScale(s2);
        setTx(nTx);
        setTy(nTy);
    }, [width, height, clampT]);

    // Non-passive wheel listener so preventDefault() actually stops page scroll.
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const factor = Math.exp(-e.deltaY * 0.0015);
            applyZoom(stateRef.current.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [applyZoom]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (stateRef.current.scale <= 1) return;
        dragRef.current = { x: e.clientX, y: e.clientY, tx: stateRef.current.tx, ty: stateRef.current.ty };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const s = stateRef.current.scale;
        setTx(clampT(drag.tx + (e.clientX - drag.x), s, width));
        setTy(clampT(drag.ty + (e.clientY - drag.y), s, height));
    };
    const onPointerUp = () => {
        dragRef.current = null;
    };

    const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = rect ? e.clientX - rect.left : width / 2;
        const cy = rect ? e.clientY - rect.top : height / 2;
        applyZoom(stateRef.current.scale > 1 ? 1 : DOUBLE_CLICK_SCALE, cx, cy);
    };

    return (
        <div
            ref={containerRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onDoubleClick={onDoubleClick}
            style={{
                width,
                height,
                background: '#000',
                overflow: 'hidden',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                touchAction: 'none',
                cursor: scale > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
            }}
        >
            <img
                src={uri}
                draggable={false}
                style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                    transformOrigin: 'center center',
                    userSelect: 'none',
                }}
            />
            <button
                onClick={onClose}
                // Stop the container's pan/pointer-capture from hijacking the
                // click while zoomed in (otherwise × does nothing at scale > 1).
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Close image"
                style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    border: 'none',
                    background: 'rgba(0,0,0,0.45)',
                    color: '#fff',
                    fontSize: 24,
                    lineHeight: '24px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                ×
            </button>
        </div>
    );
}

/**
 * Fullscreen, zoomable Mermaid diagram viewer (web).
 *
 * Renders the diagram to SVG (same as MermaidRenderer's web path) and zooms by
 * CSS-transforming the SVG wrapper — wheel-zoom toward the cursor, drag-to-pan
 * when zoomed, double-click toggle, Esc / × to close. The SVG is vector, so it
 * stays crisp. Metro resolves this over `MermaidViewer.tsx` on web.
 */
import * as React from 'react';
import { useWindowDimensions } from 'react-native';

const MAX_SCALE = 8;
const DOUBLE_CLICK_SCALE = 2.5;

interface MermaidViewerProps {
    content: string;
    onClose: () => void;
}

export function MermaidViewer({ content, onClose }: MermaidViewerProps) {
    const { width, height } = useWindowDimensions();
    const [svg, setSvg] = React.useState<string | null>(null);
    const [err, setErr] = React.useState(false);
    const [scale, setScale] = React.useState(1);
    const [tx, setTx] = React.useState(0);
    const [ty, setTy] = React.useState(0);

    const containerRef = React.useRef<HTMLDivElement>(null);
    const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
    const stateRef = React.useRef({ scale, tx, ty });
    stateRef.current = { scale, tx, ty };

    React.useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const mod: any = await import('mermaid');
                const mermaid = mod.default || mod;
                mermaid.initialize?.({ startOnLoad: false, theme: 'dark' });
                const rendered = await mermaid.render(`mv-${Date.now()}`, content);
                if (mounted) setSvg(rendered.svg);
            } catch {
                if (mounted) setErr(true);
            }
        })();
        return () => { mounted = false; };
    }, [content]);

    const applyZoom = React.useCallback((nextScale: number, cx: number, cy: number) => {
        const { scale: s, tx: curTx, ty: curTy } = stateRef.current;
        const s2 = Math.min(MAX_SCALE, Math.max(1, nextScale));
        const px = cx - width / 2;
        const py = cy - height / 2;
        let nTx = px - (px - curTx) * (s2 / s);
        let nTy = py - (py - curTy) * (s2 / s);
        if (s2 <= 1) { nTx = 0; nTy = 0; }
        setScale(s2);
        setTx(nTx);
        setTy(nTy);
    }, [width, height]);

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
    }, [applyZoom, svg]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (stateRef.current.scale <= 1) return;
        dragRef.current = { x: e.clientX, y: e.clientY, tx: stateRef.current.tx, ty: stateRef.current.ty };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        setTx(d.tx + (e.clientX - d.x));
        setTy(d.ty + (e.clientY - d.y));
    };
    const onPointerUp = () => { dragRef.current = null; };

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
                cursor: scale > 1 ? 'grab' : 'default',
            }}
        >
            {err ? (
                <div style={{ color: '#ff6b6b', fontFamily: 'monospace', whiteSpace: 'pre-wrap', padding: 16 }}>
                    Mermaid diagram syntax error
                </div>
            ) : svg ? (
                <div
                    style={{
                        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                        transformOrigin: 'center center',
                        maxWidth: '100%',
                        maxHeight: '100%',
                    }}
                    dangerouslySetInnerHTML={{ __html: svg }}
                />
            ) : (
                <div style={{ color: '#888' }}>…</div>
            )}
            <button
                onClick={onClose}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Close diagram"
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

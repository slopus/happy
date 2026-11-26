import '../vendor/dsh-image-gen/src/client/tl/css-supports-shim';
import 'tldraw/tldraw.css';
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { StudioTlCanvas } from '../vendor/dsh-image-gen/src/client/tl/studio-tl-canvas';
import { TL_THEME_CSS } from '../vendor/dsh-image-gen/src/client/tl/tl-theme-css';
import { exportSelectionPreview } from '../vendor/dsh-image-gen/src/client/tl/canvas-selection';
import type { ProjectCanvasPalette } from './protocol';
import { currentSync, postCanvasMessage, startParentConnection, subscribeSync } from './host/bridge';
import { getCanvasEditor, selectedAssetIds } from './host/editor';

const style = document.createElement('style');
style.textContent = `${TL_THEME_CSS}
html, body, #root { height: 100%; width: 100%; margin: 0; overflow: hidden; }
.paws-canvas-root { position: relative; height: 100%; width: 100%; }
.dsh-ig-tl-canvas { position: absolute; inset: 0; overflow: hidden; }
.dsh-ig-canvas-sync-status:not([data-phase="error"]) { display: none; }
.dsh-ig-canvas-sync-status[data-phase="error"] {
    position: absolute; z-index: 1000; bottom: 48px; left: 50%; transform: translateX(-50%);
    max-width: min(90%, 440px); padding: 6px 10px; border-radius: 8px;
    color: var(--paws-canvas-text); background: var(--paws-canvas-panel);
    border: 1px solid var(--paws-canvas-border); font: 14px system-ui, sans-serif;
}
.paws-canvas-clip {
    position: absolute; z-index: 1000; bottom: 12px; left: 50%;
    transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
    color: var(--paws-canvas-text); background: var(--paws-canvas-panel);
    border: 1px solid var(--paws-canvas-border); border-radius: 8px; padding: 3px 8px;
    font: 12px system-ui, sans-serif;
}
.paws-canvas-clip button {
    padding: 5px 4px; border: 0; background: transparent; color: inherit;
    cursor: pointer; font: inherit; white-space: nowrap;
}
.paws-canvas-clip button:disabled { cursor: progress; }
.paws-canvas-clip button:focus-visible { outline: 2px solid var(--paws-canvas-focus); border-radius: 4px; }
.paws-image-style { margin: 8px; pointer-events: auto; }
.paws-image-style-toggle {
    min-height: 28px; padding: 0 9px; border-radius: 7px;
    font: 12px system-ui, sans-serif; color: var(--tl-color-text);
    background: var(--tl-color-panel); border: 1px solid var(--tl-color-divider);
    cursor: pointer;
}
.paws-image-style-toggle:hover, .paws-image-style-toggle[data-state="open"] {
    background: var(--tl-color-hint);
}
.paws-image-style-toggle:focus-visible { outline: 2px solid var(--tl-color-focus); outline-offset: 1px; }
.paws-canvas-root { --paws-canvas-text: #242f44; --paws-canvas-panel: #fff;
    --paws-canvas-border: #d9e2f2; --paws-canvas-focus: #2f64f5; }
body[data-ds-dark-theme] .paws-canvas-root { --paws-canvas-text: #f5f7fa;
    --paws-canvas-panel: #252629; --paws-canvas-border: #57585c; --paws-canvas-focus: #9bb2ff; }
.paws-canvas-root[data-paws-canvas-palette] { background: var(--paws-canvas-board); }
.paws-canvas-root[data-paws-canvas-palette] .tl-container {
    --tl-color-background: var(--paws-canvas-board);
    --tl-color-panel: var(--paws-canvas-panel);
    --tl-color-panel-contrast: var(--paws-canvas-panel);
    --tl-color-low: var(--paws-canvas-panel);
    --tl-color-low-border: var(--paws-canvas-border);
    --tl-color-divider: var(--paws-canvas-border);
    --tl-color-text: var(--paws-canvas-text);
    --tl-color-text-0: var(--paws-canvas-text);
    --tl-color-text-1: var(--paws-canvas-text);
    --tl-color-grid: color-mix(in srgb, var(--paws-canvas-text) 25%, var(--paws-canvas-border));
    --tl-color-focus: var(--paws-canvas-focus);
    --tl-color-primary: var(--paws-canvas-focus);
    --tl-color-selected: var(--paws-canvas-focus);
    --tl-color-selection-stroke: var(--paws-canvas-focus);
    --tl-color-selection-fill: color-mix(in srgb, var(--paws-canvas-focus) 14%, transparent);
    --tl-color-hint: var(--paws-canvas-selected);
    --tl-color-muted-1: var(--paws-canvas-selected);
    --tl-color-muted-2: color-mix(in srgb, var(--paws-canvas-focus) 7%, transparent);
}
.paws-canvas-root[data-paws-canvas-palette] .tl-container .tl-background { background-image: none; }
.paws-canvas-root[data-paws-canvas-palette] .tl-container :is(.tlui-menu-zone, .tlui-navigation-panel)::before,
.paws-canvas-root[data-paws-canvas-palette] .tl-container .tlui-menu-zone {
    background-color: var(--paws-canvas-panel);
    border-color: var(--paws-canvas-border);
}
.paws-canvas-root[data-paws-canvas-palette] .tl-container :is(.tlui-main-toolbar__tools, .tlui-style-panel__wrapper, .tlui-menu, .tlui-popover__content) {
    border-color: var(--paws-canvas-border);
}
.paws-canvas-root[data-paws-canvas-palette] .tl-container .tlui-button[data-isactive="true"] { color: var(--paws-canvas-focus); }
.paws-canvas-root[data-paws-canvas-palette] .tl-container .tlui-button[data-isactive="true"]::after { background: var(--paws-canvas-selected); }
`;
document.head.append(style);

function paletteStyle(palette: ProjectCanvasPalette | undefined): CSSProperties | undefined {
    if (!palette) return undefined;
    return {
        '--paws-canvas-board': palette.background,
        '--paws-canvas-panel': palette.surface,
        '--paws-canvas-text': palette.text,
        '--paws-canvas-border': palette.divider,
        '--paws-canvas-focus': palette.accent,
        '--paws-canvas-selected': palette.surfaceSelected,
    } as CSSProperties;
}

function Canvas({ lang, licenseKey, sessionKey, palette }: { lang: 'zh' | 'en'; licenseKey?: string; sessionKey: string; palette?: ProjectCanvasPalette }) {
    const [canClip, setCanClip] = useState(false);
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const updateSelection = (event: Event): void => {
            if (event instanceof CustomEvent && typeof event.detail === 'boolean') setCanClip(event.detail);
            setFailed(false);
        };
        window.addEventListener('paws-canvas-selection', updateSelection);
        return () => window.removeEventListener('paws-canvas-selection', updateSelection);
    }, []);

    async function clip(): Promise<void> {
        const editor = getCanvasEditor();
        if (!editor || pending) return;
        const shapes = editor.getSelectedShapes();
        if (shapes.length === 0) return;
        const ids = selectedAssetIds(shapes);
        setPending(true);
        setFailed(false);
        try {
            const dataUrl = await exportSelectionPreview(editor, shapes, 4_000_000, AbortSignal.timeout(15_000));
            if (currentSync()?.sessionKey !== sessionKey || getCanvasEditor() !== editor) return;
            postCanvasMessage({ type: 'paws-project-canvas/clip', sessionKey, ids, dataUrl });
        } catch {
            setFailed(true);
        } finally {
            setPending(false);
        }
    }

    return <div className="paws-canvas-root" data-project-canvas-embedded="dsh-image-gen"
        data-paws-canvas-palette={palette ? '' : undefined} style={paletteStyle(palette)}>
        <StudioTlCanvas lang={lang} licenseKey={licenseKey} />
        {canClip && <div className="paws-canvas-clip">
            <button type="button" onClick={() => { void clip(); }} disabled={pending}>
                {lang === 'zh' ? '将选区截图加入对话' : 'Attach selection snapshot'}
            </button>
            {failed && <span role="status">{lang === 'zh' ? '未能截图' : 'Snapshot failed'}</span>}
        </div>}
    </div>;
}

function App() {
    const sync = useSyncExternalStore(subscribeSync, currentSync);
    useEffect(() => {
        document.body.toggleAttribute('data-ds-dark-theme', sync?.theme === 'dark');
    }, [sync?.theme]);
    if (!sync) return null;
    return <Canvas key={sync.sessionKey} lang={sync.locale ?? 'zh'} licenseKey={sync.licenseKey} sessionKey={sync.sessionKey} palette={sync.palette} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Canvas root element is missing');
createRoot(root).render(<App />);
startParentConnection();

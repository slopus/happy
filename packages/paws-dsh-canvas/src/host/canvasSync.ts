import type { Editor } from 'tldraw';
import { currentSync, postCanvasMessage } from './bridge';
import { selectedAssetIds } from './editor';

export type CanvasSyncStatus =
    | { phase: 'idle' | 'preparing' | 'ready'; count: number }
    | { phase: 'error'; count: number; error?: string };

export type CanvasSyncHandle = (() => void) & { retry(): void };

/** Use the editor's selection while keeping a drag out of the chat draft. */
export function startCanvasSync(editor: Editor, onStatus: (status: CanvasSyncStatus) => void): CanvasSyncHandle {
    const sessionKey = currentSync()?.sessionKey;
    let lastSelection: string | undefined;
    let pointer: { id: number; x: number; y: number; moved: boolean; onCanvas: boolean } | undefined;

    function reflectSelection(send: boolean, explicitClick = false): void {
        if (!sessionKey || currentSync()?.sessionKey !== sessionKey) return;
        const shapes = editor.getSelectedShapes();
        const selected = shapes.map(shape => shape.id).join('|');
        const changed = selected !== lastSelection;
        lastSelection = selected;
        const ids = changed || send ? selectedAssetIds(shapes) : [];
        if (changed) {
            onStatus({ phase: shapes.length > 0 ? 'ready' : 'idle', count: shapes.length });
            const canClip = shapes.length > 1 || shapes.some(shape => shape.type !== 'image');
            window.dispatchEvent(new CustomEvent('paws-canvas-selection', { detail: canClip }));
            postCanvasMessage({ type: 'paws-project-canvas/selection', sessionKey, ids });
        }
        if (send && (changed || explicitClick)) {
            if (ids.length) postCanvasMessage({ type: 'paws-project-canvas/select', sessionKey, ids });
        }
    }

    const move = (event: PointerEvent): void => {
        if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) pointer.moved = true;
    };
    const down = (event: PointerEvent): void => {
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
            onCanvas: event.target instanceof Element && !!event.target.closest('.tl-canvas') };
    };
    const up = (event: PointerEvent): void => {
        if (pointer?.id !== event.pointerId) return;
        move(event);
        const click = pointer.onCanvas && !pointer.moved && event.button === 0;
        queueMicrotask(() => {
            pointer = undefined;
            const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
            const hit = click && editor.getShapeAtPoint(point, { hitInside: true, renderingOnly: true });
            reflectSelection(!!hit, !!hit && editor.getSelectedShapeIds().includes(hit.id));
        });
    };
    const cancel = (): void => { pointer = undefined; reflectSelection(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel);
    const dispose = editor.store.listen(() => reflectSelection(!pointer), { source: 'user', scope: 'session' });
    const disposeRemote = editor.store.listen(() => reflectSelection(false), { source: 'remote', scope: 'session' });
    reflectSelection(false);
    return Object.assign(() => {
        dispose();
        disposeRemote();
        window.removeEventListener('pointerdown', down, true);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancel);
    }, { retry: () => reflectSelection(true, true) });
}

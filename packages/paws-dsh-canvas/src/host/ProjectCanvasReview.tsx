import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Box, uniqueId, useEditor, useValue, type Editor } from 'tldraw';
import { PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS, type ProjectCanvasReviewMark, type ProjectCanvasSync } from '../protocol';
import { currentSync, postCanvasMessage, subscribeSync } from './bridge';
import { getCanvasEditor, selectedAssetIds } from './editor';
import { captureReviewMark, reviewInk, reviewShapesIn, type ReviewBounds } from './reviewCapture';
import './review.css';

type Review = NonNullable<ProjectCanvasSync['review']>;
type Point = { x: number; y: number };
type Gesture = { pageId: string; pointerId: number; start: Point; origin: Point };
type Pending = {
    mark: ProjectCanvasReviewMark;
    controller: AbortController;
    sent: boolean;
    timeout?: number;
};

function viewportPoint(editor: Editor, point: Point): Point {
    const viewport = editor.getViewportScreenBounds();
    return {
        x: Math.max(viewport.x, Math.min(viewport.x + viewport.w, point.x)),
        y: Math.max(viewport.y, Math.min(viewport.y + viewport.h, point.y)),
    };
}

function gestureBounds(editor: Editor, start: Point, end: Point, origin: Point = editor.screenToPage(start)): ReviewBounds {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 5) return { x: origin.x, y: origin.y, w: 0, h: 0 };
    const finish = editor.screenToPage(end);
    const minimum = 1 / editor.getZoomLevel();
    return {
        x: Math.min(origin.x, finish.x), y: Math.min(origin.y, finish.y),
        w: Math.max(minimum, Math.abs(origin.x - finish.x)), h: Math.max(minimum, Math.abs(origin.y - finish.y)),
    };
}

function endPending(pending: Pending): void {
    pending.controller.abort();
    window.clearTimeout(pending.timeout);
}

function MarkShape({ bounds, number, draft }: { bounds: ReviewBounds; number: number; draft?: boolean }) {
    const editor = useEditor();
    const camera = useValue('project canvas review camera', () => editor.getCamera(), [editor]);
    const viewportWidth = useValue('project canvas review width', () => editor.getViewportScreenBounds().w, [editor]);
    const point = bounds.w === 0;
    const x = (bounds.x + camera.x) * camera.z;
    const y = (bounds.y + camera.y) * camera.z;
    return <div className="paws-review-mark" data-point={point || undefined} data-draft={draft || undefined}
        style={{ left: x, top: y, width: bounds.w * camera.z, height: bounds.h * camera.z }}>
        <span className="paws-review-mark__number" style={{
            left: x >= 0 && x < viewportWidth && x + 28 > viewportWidth ? -16 : 16,
            top: y >= 0 && y < 28 ? 16 : -16,
        }}>{number}</span>
    </div>;
}

function ReviewTool({ review, sessionKey, english }: { review: Review; sessionKey: string; english: boolean }) {
    const editor = useEditor();
    const pageId = useValue('project canvas review page', () => editor.getCurrentPageId(), [editor]);
    const [armed, setArmed] = useState(false);
    const [preview, setPreview] = useState<ReviewBounds>();
    const [saving, setSaving] = useState<ProjectCanvasReviewMark>();
    const [status, setStatus] = useState<'added' | 'failed'>();
    const keyboardPoint = useRef<Point | undefined>(undefined);
    const gesture = useRef<Gesture | undefined>(undefined);
    const pending = useRef<Pending | undefined>(undefined);
    const button = useRef<HTMLButtonElement>(null);
    const surface = useRef<HTMLDivElement>(null);
    const drawing = armed && (review.capacity > 0 || saving !== undefined);
    const activeMarks = review.marks.filter(mark => mark.pageId === pageId);
    const acknowledged = saving !== undefined && review.marks.some(mark => mark.id === saving.id);
    const rejected = saving !== undefined && review.rejectedId === saving.id;

    function finish(request: Pending, nextStatus?: 'added' | 'failed'): void {
        if (pending.current !== request) return;
        endPending(request);
        pending.current = undefined;
        setSaving(undefined);
        setStatus(nextStatus);
    }

    useEffect(() => () => {
        if (pending.current) endPending(pending.current);
        pending.current = undefined;
    }, []);
    useEffect(() => {
        const request = pending.current;
        if (request && (acknowledged || rejected)) finish(request, acknowledged ? 'added' : 'failed');
    }, [acknowledged, rejected]);
    useEffect(() => {
        gesture.current = undefined;
        keyboardPoint.current = undefined;
        setPreview(undefined);
        const request = pending.current;
        if (request && !request.sent && request.mark.pageId !== pageId) finish(request);
    }, [pageId]);
    useEffect(() => {
        if (drawing) surface.current?.focus({ preventScroll: true });
    }, [drawing]);
    useEffect(() => {
        if (review.capacity === 0 && !saving) {
            setArmed(false);
            setPreview(undefined);
            keyboardPoint.current = undefined;
            gesture.current = undefined;
        }
    }, [review.capacity, saving]);

    function setMode(next: boolean): void {
        gesture.current = undefined;
        keyboardPoint.current = undefined;
        setPreview(undefined);
        setStatus(undefined);
        setArmed(next);
        if (!next) button.current?.focus({ preventScroll: true });
    }

    async function addMark(bounds: ReviewBounds): Promise<void> {
        const sync = currentSync();
        if (pending.current || sync?.sessionKey !== sessionKey || sync.review?.scope !== review.scope
            || sync.review.capacity === 0 || getCanvasEditor() !== editor) return;

        const point = bounds.w === 0;
        const hit = point ? editor.getShapeAtPoint(bounds, {
            hitInside: true, hitLocked: true, filter: shape => shape.type === 'image',
        }) : undefined;
        const shapes = point ? (hit ? [hit] : []) : reviewShapesIn(editor, new Box(bounds.x, bounds.y, bounds.w, bounds.h));
        const mark = {
            id: uniqueId().replaceAll('_', '-'), number: sync.review.nextNumber, pageId: editor.getCurrentPageId(),
            bounds, ids: selectedAssetIds(shapes),
        };
        const request: Pending = { mark, controller: new AbortController(), sent: false };
        pending.current = request;
        request.timeout = window.setTimeout(() => finish(request, 'failed'), 15_000);
        setSaving(mark);
        setStatus(undefined);

        try {
            const dataUrl = await captureReviewMark(editor, mark, request.controller.signal);
            if (pending.current !== request || request.controller.signal.aborted) return;
            const latest = currentSync();
            if (latest?.sessionKey !== sessionKey || latest.review?.scope !== review.scope
                || getCanvasEditor() !== editor || editor.getCurrentPageId() !== mark.pageId) {
                finish(request);
                return;
            }
            if (latest.review.capacity === 0 || latest.review.nextNumber !== mark.number) {
                finish(request, 'failed');
                return;
            }
            request.sent = true;
            window.clearTimeout(request.timeout);
            const expiresAt = Date.now() + PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS;
            request.timeout = window.setTimeout(() => finish(request, 'failed'), PROJECT_CANVAS_REVIEW_ACK_TIMEOUT_MS);
            postCanvasMessage({ type: 'paws-project-canvas/review-mark', sessionKey, reviewScope: review.scope, mark, expiresAt, dataUrl });
        } catch {
            finish(request, 'failed');
        }
    }

    function start(event: PointerEvent<HTMLDivElement>): void {
        if (!event.isPrimary || event.button !== 0 || pending.current || review.capacity === 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY };
        const origin = editor.screenToPage(start);
        gesture.current = { pageId, pointerId: event.pointerId, start, origin };
        keyboardPoint.current = undefined;
        setPreview(gestureBounds(editor, start, start, origin));
    }

    function update(event: PointerEvent<HTMLDivElement>, complete: boolean): void {
        const drag = gesture.current;
        if (drag?.pointerId !== event.pointerId || drag.pageId !== editor.getCurrentPageId()) return;
        const end = viewportPoint(editor, { x: event.clientX, y: event.clientY });
        const bounds = gestureBounds(editor, drag.start, end, drag.origin);
        if (!complete) {
            setPreview(bounds);
            return;
        }
        gesture.current = undefined;
        setPreview(undefined);
        void addMark(bounds);
    }

    function cancelGesture(event: PointerEvent<HTMLDivElement>): void {
        if (gesture.current?.pointerId !== event.pointerId) return;
        gesture.current = undefined;
        setPreview(undefined);
    }

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        // Capture before tldraw's native container handler moves a selected shape.
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            setMode(false);
            return;
        }
        if (event.key === 'Tab') return;
        if (pending.current || gesture.current || review.capacity === 0) return;
        const viewport = editor.getViewportScreenBounds();
        const current = keyboardPoint.current ?? { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
        const step = event.shiftKey ? 1 : 16;
        const deltas: Record<string, Point> = {
            ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
        };
        const delta = deltas[event.key];
        if (delta) {
            event.preventDefault();
            keyboardPoint.current = viewportPoint(editor, { x: current.x + delta.x, y: current.y + delta.y });
            setPreview(gestureBounds(editor, keyboardPoint.current, keyboardPoint.current));
        } else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
            event.preventDefault();
            setPreview(undefined);
            void addMark(gestureBounds(editor, current, current));
        }
    }

    const label = english ? 'Mark for chat' : '打标';
    const help = english ? 'Click or drag to mark. Arrow keys move a point, Enter adds it, Escape exits.'
        : '点击或拖动打标。方向键移动标点，Enter 添加，Escape 退出。';
    const message = saving ? (english ? 'Attaching…' : '正在添加…')
        : status === 'failed' ? (english ? 'Could not attach mark. Try again.' : '标注添加失败，请重试。')
        : status === 'added' ? (english ? 'Mark attached to chat' : '标注已加入对话')
        : '';
    const limit = english ? 'Attachment limit reached' : '已达附件上限';

    return <div style={{ '--paws-review-ink': reviewInk } as CSSProperties}>
        {drawing && <div ref={surface} tabIndex={0} className="paws-review-surface" role="group"
            aria-label={help} data-busy={saving !== undefined || undefined} data-testid="paws-canvas-review-surface"
            onPointerDown={start} onPointerMove={event => update(event, false)} onPointerUp={event => update(event, true)}
            onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
            onKeyDownCapture={onKeyDown} onKeyUpCapture={event => event.stopPropagation()} />}
        <div className="paws-review-marks" aria-hidden="true">
            {activeMarks.map(mark => <MarkShape key={mark.id} bounds={mark.bounds} number={mark.number} />)}
            {saving && !acknowledged && saving.pageId === pageId && <MarkShape bounds={saving.bounds} number={saving.number} draft />}
            {preview && drawing && <MarkShape bounds={preview} number={review.nextNumber} draft />}
        </div>
        <div className="paws-review-tool">
            <button ref={button} type="button" aria-pressed={drawing} aria-disabled={!drawing && review.capacity === 0}
                className="paws-review-tool__toggle" data-testid="paws-canvas-review-toggle"
                title={review.capacity === 0 ? limit : help}
                onClick={() => { if (drawing || review.capacity > 0) setMode(!drawing); }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="9" cy="11" r="4" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M9 4v3m0 8v2m-6-6h2m8 0h3m-1-8v5m-2.5-2.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                {label}
            </button>
            <span className="paws-review-tool__status" role="status" data-failed={status === 'failed' || undefined}>
                {message || (drawing ? (english ? 'Click or drag' : '单击或框选') : '')}
            </span>
        </div>
    </div>;
}

export function ProjectCanvasReview() {
    const sync = useSyncExternalStore(subscribeSync, currentSync);
    if (!sync?.review) return null;
    return <ReviewTool key={sync.review.scope} review={sync.review} sessionKey={sync.sessionKey} english={sync.locale === 'en'} />;
}

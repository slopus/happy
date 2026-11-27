import { Box, type Editor, type TLShape } from 'tldraw';
import { blobToDataUrl } from '../../vendor/dsh-image-gen/src/client/browser-image-utils';
import type { ProjectCanvasReviewMark } from '../protocol';

export const reviewInk = '#bb492e';
export type ReviewBounds = ProjectCanvasReviewMark['bounds'];
const maxBytes = 4_000_000;
const longestSide = 1536;

export function reviewShapesIn(editor: Editor, bounds: Box): TLShape[] {
    return editor.getCurrentPageShapesSorted().filter(shape => {
        if (shape.type === 'group' || editor.isShapeHidden(shape)) return false;
        const shapeBounds = editor.getShapeMaskedPageBounds(shape);
        return shapeBounds?.collides(bounds) ?? false;
    });
}

function cropAround(bounds: ReviewBounds, zoom: number): Box {
    // Leave room for the badge when a wide viewport or a long, thin
    // rectangle is reduced to attachment dimensions.
    const paddingScale = Math.min(zoom * 1.5, (longestSide - 96) / Math.max(1, bounds.w, bounds.h));
    const horizontalPadding = Math.max(30 / zoom, 24 / paddingScale);
    const verticalPadding = Math.max(34 / zoom, 36 / paddingScale);
    const width = Math.max(bounds.w + 2 * horizontalPadding, (bounds.w === 0 ? 340 : 108) / zoom);
    const height = Math.max(bounds.h + 2 * verticalPadding, (bounds.h === 0 ? 250 : 108) / zoom);
    return new Box(bounds.x + (bounds.w - width) / 2, bounds.y + (bounds.h - height) / 2, width, height);
}

function drawMark(context: CanvasRenderingContext2D, crop: Box, { bounds, number }: ProjectCanvasReviewMark): void {
    const scaleX = context.canvas.width / crop.w;
    const scaleY = context.canvas.height / crop.h;
    const x = (bounds.x - crop.x) * scaleX;
    const y = (bounds.y - crop.y) * scaleY;
    const point = bounds.w === 0;

    context.beginPath();
    if (point) context.arc(x, y, 6, 0, Math.PI * 2);
    else context.rect(x, y, bounds.w * scaleX, bounds.h * scaleY);
    context.lineWidth = 5;
    context.strokeStyle = '#fff';
    context.stroke();
    context.lineWidth = 2.5;
    context.strokeStyle = reviewInk;
    context.stroke();

    context.font = '700 12px system-ui, sans-serif';
    const label = String(number);
    const radius = Math.max(11, context.measureText(label).width / 2 + 4);
    const inset = radius + 1;
    const badgeX = Math.min(context.canvas.width - inset, Math.max(inset, x + 16));
    const badgeY = Math.min(context.canvas.height - inset, Math.max(inset, y - 16));
    context.beginPath();
    context.arc(badgeX, badgeY, radius, 0, Math.PI * 2);
    context.fillStyle = reviewInk;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, badgeX, badgeY);
}

function encode(canvas: HTMLCanvasElement, mimeType: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode canvas review'));
    }, mimeType, quality));
}

/** Rasterize the marked crop only. Review marks never enter the saved scene. */
export async function captureReviewMark(editor: Editor, mark: ProjectCanvasReviewMark, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const zoom = editor.getZoomLevel();
    const crop = cropAround(mark.bounds, zoom);
    const shapes = reviewShapesIn(editor, crop);
    const scale = Math.min(zoom * 1.5, longestSide / Math.max(crop.w, crop.h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.w * scale));
    canvas.height = Math.max(1, Math.round(crop.h * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not draw canvas review');
    context.fillStyle = getComputedStyle(editor.getContainer()).getPropertyValue('--tl-color-background').trim() || '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (shapes.length) {
        // A single-frame SDK export omits its border. Include that frame in
        // the normal multi-shape export path so the crop matches the editor.
        const exported = shapes.length === 1 && editor.isShapeFrameLike(shapes[0]) ? [shapes[0], shapes[0]] : shapes;
        const { blob } = await editor.toImage(exported, {
            bounds: crop, scale, pixelRatio: 1, format: 'png', background: false, padding: 0,
        });
        signal.throwIfAborted();
        const bitmap = await createImageBitmap(blob);
        try {
            signal.throwIfAborted();
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        } finally {
            bitmap.close();
        }
    }

    drawMark(context, crop, mark);
    let evidence = await encode(canvas, 'image/png');
    signal.throwIfAborted();
    if (evidence.size > maxBytes) evidence = await encode(canvas, 'image/jpeg', 0.84);
    signal.throwIfAborted();
    if (evidence.size > maxBytes) throw new Error('Canvas review image exceeds the attachment limit');
    return blobToDataUrl(evidence);
}

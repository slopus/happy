import { GOAL_CANVAS_LIMITS } from '@slopus/happy-wire';

const previewSide = 640;

/** The browser prepares a bounded still image while the original stays intact. */
export async function createProjectCanvasPreview(source: Blob, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    const url = URL.createObjectURL(source);
    const image = new Image();
    const canvas = document.createElement('canvas');
    try {
        image.src = url;
        await image.decode();
        const longest = Math.max(image.naturalWidth, image.naturalHeight);
        if (!longest) throw new Error('Could not decode this canvas image');
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Could not prepare the canvas image preview');
        for (const [maxSide, quality] of [[previewSide, 0.82], [480, 0.72], [320, 0.6], [160, 0.55]]) {
            signal.throwIfAborted();
            const scale = Math.min(1, maxSide / longest);
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const preview = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (preview?.type === 'image/jpeg' && preview.size <= GOAL_CANVAS_LIMITS.previewBytes) {
                signal.throwIfAborted();
                return preview;
            }
        }
        throw new Error('Canvas image preview exceeds its byte limit');
    } finally {
        URL.revokeObjectURL(url);
        canvas.width = canvas.height = 0;
    }
}

import type { AttachmentImageSourceOptions, LoadedAttachmentImageSource } from './attachmentImageSourceTypes';
import { getAttachmentPreviewSize } from './attachmentImageSourceTypes';

function toOwnedBlob(bytes: Uint8Array, mime: string): Blob {
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return new Blob([owned.buffer], { type: mime });
}

function objectUrlSource(blob: Blob): LoadedAttachmentImageSource {
    const uri = URL.createObjectURL(blob);
    return {
        uri,
        byteSize: blob.size,
        dispose: () => URL.revokeObjectURL(uri),
    };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
}

export async function createAttachmentImageSource(
    bytes: Uint8Array,
    mime: string,
    options: AttachmentImageSourceOptions = {},
): Promise<LoadedAttachmentImageSource> {
    const original = toOwnedBlob(bytes, mime);
    const previewSize = getAttachmentPreviewSize(options);
    if (!previewSize || typeof createImageBitmap !== 'function') {
        return objectUrlSource(original);
    }

    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(original, {
            resizeWidth: previewSize.width,
            resizeHeight: previewSize.height,
            resizeQuality: 'high',
        });
        const canvas = document.createElement('canvas');
        canvas.width = previewSize.width;
        canvas.height = previewSize.height;
        const context = canvas.getContext('2d');
        if (!context) return objectUrlSource(original);
        context.drawImage(bitmap, 0, 0, previewSize.width, previewSize.height);
        const preview = await canvasToBlob(canvas);
        return objectUrlSource(preview ?? original);
    } catch {
        return objectUrlSource(original);
    } finally {
        bitmap?.close();
    }
}

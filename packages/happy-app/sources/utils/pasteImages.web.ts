/**
 * Extract image files from a ClipboardEvent or DragEvent on web.
 * Returns File objects that can be read and added as AttachmentPreview items.
 */

export function getImagesFromClipboard(event: ClipboardEvent): File[] {
    const items = event.clipboardData?.items;
    if (!items) return [];

    const images: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) images.push(file);
        }
    }
    return images;
}

export function getImagesFromDrop(event: DragEvent): File[] {
    const files = event.dataTransfer?.files;
    if (!files) return [];

    const images: File[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
            images.push(file);
        }
    }
    return images;
}

export async function fileToAttachmentPreview(
    file: File,
    generateThumbhash: (uri: string, w: number, h: number) => Promise<string | undefined>,
): Promise<{
    uri: string;
    width: number;
    height: number;
    size: number;
    name: string;
    mimeType: string;
    thumbhash?: string;
} | null> {
    try {
        const uri = URL.createObjectURL(file);

        // Get dimensions by loading as an Image element
        const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
            img.onload = () => {
                clearTimeout(timeout);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('load error'));
            };
            img.src = uri;
        });

        const thumbhash = (width > 0 && height > 0)
            ? await generateThumbhash(uri, width, height)
            : undefined;

        return {
            uri,
            width,
            height,
            size: file.size,
            name: file.name || `paste_${Date.now()}.png`,
            mimeType: file.type || 'image/png',
            thumbhash,
        };
    } catch {
        return null;
    }
}

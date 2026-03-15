const PREVIEW_IMAGE_MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
};

function getFileExtension(path: string): string | null {
    const fileName = path.split('/').pop() || '';
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext || ext === fileName.toLowerCase()) {
        return null;
    }
    return ext;
}

export function isPreviewableImage(path: string): boolean {
    const ext = getFileExtension(path);
    return !!ext && ext in PREVIEW_IMAGE_MIME_BY_EXT;
}

export function getImageMimeType(path: string): string | null {
    const ext = getFileExtension(path);
    if (!ext) return null;
    return PREVIEW_IMAGE_MIME_BY_EXT[ext] ?? null;
}

export function getExtensionFromMimeType(mimeType: string): string {
    for (const [ext, mime] of Object.entries(PREVIEW_IMAGE_MIME_BY_EXT)) {
        if (mime === mimeType) return ext;
    }
    return 'png';
}

/**
 * Which files are worth showing as a picture rather than as "binary file".
 *
 * A diff of an icon is meaningless as text and meaningful as an image, so the
 * viewer swaps in a before/after view for formats the platform can actually
 * decode. Anything not listed stays a binary placeholder — better an honest
 * placeholder than a broken image box.
 */

/** Extension → the MIME type a data: URI needs. */
const IMAGE_MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    // SVG is text and diffs perfectly well as text, so it is deliberately absent.
};

export function imageMimeType(path: string): string | null {
    const dot = path.lastIndexOf('.');
    if (dot === -1) return null;
    const extension = path.slice(dot + 1).toLowerCase();
    return IMAGE_MIME_TYPES[extension] ?? null;
}

export function isImagePath(path: string): boolean {
    return imageMimeType(path) !== null;
}

/** Wraps already-base64 content in a data URI the image loader accepts. */
export function imageDataUri(path: string, base64: string): string | null {
    const mime = imageMimeType(path);
    if (!mime) return null;
    // Shell pipelines wrap base64 output; the decoder rejects the newlines.
    const clean = base64.replace(/\s+/g, '');
    if (clean.length === 0) return null;
    return `data:${mime};base64,${clean}`;
}

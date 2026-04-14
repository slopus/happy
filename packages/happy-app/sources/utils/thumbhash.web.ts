/**
 * Thumbhash generation — web implementation.
 * Draws the image onto a small Canvas to extract RGBA pixel data,
 * then encodes it with the thumbhash library.
 *
 * Output: base64-encoded thumbhash string (~55 chars), or undefined on error.
 */
import { rgbaToThumbHash } from 'thumbhash';

const THUMB_SIZE = 100; // max dimension; thumbhash works best ≤100px

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export async function generateThumbhash(
    uri: string,
    width: number,
    height: number,
): Promise<string | undefined> {
    try {
        // Scale down to THUMB_SIZE on the longest edge
        const scale = THUMB_SIZE / Math.max(width, height);
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;

        await new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                ctx.drawImage(img, 0, 0, w, h);
                resolve();
            };
            img.onerror = reject;
            img.src = uri;
        });

        const { data } = ctx.getImageData(0, 0, w, h);
        const hash = rgbaToThumbHash(w, h, data);
        return toBase64(hash);
    } catch {
        return undefined;
    }
}

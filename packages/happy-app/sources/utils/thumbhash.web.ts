/**
 * Thumbhash generation — web implementation.
 * Draws the image onto a small Canvas to extract RGBA pixel data,
 * then encodes it with the thumbhash library.
 *
 * Output: base64-encoded thumbhash string (~55 chars), or undefined on error.
 *
 * Assumes expo-image-picker returns blob: or data: URIs on web, which do not
 * require CORS headers. If called with remote http(s) URIs lacking CORS
 * headers, image loading will fail (caught and returns undefined).
 */
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';

const THUMB_SIZE = 100; // max dimension; thumbhash works best ≤100px
const LOAD_TIMEOUT_MS = 5000;

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
    if (width <= 0 || height <= 0) return undefined;

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

            const timeout = setTimeout(() => {
                img.onload = null;
                img.onerror = null;
                reject(new Error('Thumbhash image load timeout'));
            }, LOAD_TIMEOUT_MS);

            img.onload = () => {
                clearTimeout(timeout);
                ctx.drawImage(img, 0, 0, w, h);
                resolve();
            };
            img.onerror = (e) => {
                clearTimeout(timeout);
                reject(e);
            };
            img.src = uri;
        });

        const { data } = ctx.getImageData(0, 0, w, h);
        const hash = rgbaToThumbHash(w, h, data);
        return toBase64(hash);
    } catch (e) {
        if (__DEV__) {
            console.warn('[thumbhash] generation failed:', e);
        }
        return undefined;
    }
}

export function thumbhashToDataUri(thumbhashBase64: string): string | undefined {
    try {
        const bytes = Uint8Array.from(atob(thumbhashBase64), (c) => c.charCodeAt(0));
        return thumbHashToDataURL(bytes);
    } catch {
        return undefined;
    }
}

import convert from 'heic-convert';

/**
 * HEIC/HEIF upload support for Claude image blocks.
 *
 * iPhone/iPad photos are HEIC, which the Anthropic API's strict
 * `image.source.base64.media_type` enum does NOT accept -- so the magic-byte
 * detector drops them and the photo silently vanishes from the message. Here we
 * (a) recognise HEIC/HEIF by its ISO base-media-file-format `ftyp` box, and
 * (b) transcode it to JPEG (which the API does accept) before the image block is
 * built.
 */

// HEIF/HEIC major or compatible brands seen in the ftyp box.
const HEIF_BRANDS = new Set([
    'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx',
    'heif', 'mif1', 'msf1', 'miaf', 'mira',
]);

function brandAt(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
    ).toLowerCase();
}

/**
 * True when the blob is an ISO-BMFF HEIF/HEIC file: a `ftyp` box (bytes 4..8)
 * whose major brand, or one of its compatible brands, is a known HEIF brand.
 */
export function isHeicOrHeif(bytes: Uint8Array): boolean {
    if (bytes.length < 12) {
        return false;
    }
    // Bytes 4..8 must spell "ftyp".
    if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
        return false;
    }
    // Major brand at bytes 8..12.
    if (HEIF_BRANDS.has(brandAt(bytes, 8))) {
        return true;
    }
    // Compatible brands follow, 4 bytes each, up to the declared box size.
    const declaredSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const end = Math.min(declaredSize > 0 ? declaredSize : bytes.length, bytes.length);
    for (let i = 16; i + 4 <= end; i += 4) {
        if (HEIF_BRANDS.has(brandAt(bytes, i))) {
            return true;
        }
    }
    return false;
}

/**
 * Transcode HEIC/HEIF bytes to JPEG bytes. Delegates to heic-convert
 * (libheif WASM), so it needs no native libheif on the host.
 */
export async function transcodeHeicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
    const output = await convert({
        buffer: Buffer.from(bytes),
        format: 'JPEG',
        quality: 0.92,
    });
    return new Uint8Array(output);
}

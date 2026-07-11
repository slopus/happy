import { describe, it, expect } from 'vitest';
import { isHeicOrHeif, transcodeHeicToJpeg } from './heicTranscode';

/** Build a minimal ISO-BMFF ftyp box: [size]['ftyp'][major][minor][...compat]. */
function ftyp(major: string, compatible: string[] = []): Uint8Array {
    const brands = [major, '\0\0\0\0', ...compatible];
    const size = 8 + brands.length * 4; // 4 size + 4 'ftyp' + brands
    const bytes = new Uint8Array(size);
    bytes[0] = (size >> 24) & 0xff;
    bytes[1] = (size >> 16) & 0xff;
    bytes[2] = (size >> 8) & 0xff;
    bytes[3] = size & 0xff;
    bytes.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
    let off = 8;
    for (const b of brands) {
        for (let i = 0; i < 4; i++) bytes[off + i] = b.charCodeAt(i) || 0;
        off += 4;
    }
    return bytes;
}

describe('isHeicOrHeif', () => {
    it('detects a HEIC major brand', () => {
        expect(isHeicOrHeif(ftyp('heic', ['mif1', 'heic']))).toBe(true);
    });

    it('detects HEIF via a compatible brand when the major brand is generic', () => {
        // iOS often writes major brand 'mif1' with 'heic'/'heix' in compatibles.
        expect(isHeicOrHeif(ftyp('mif1', ['heix']))).toBe(true);
    });

    it('detects a HEIF image sequence (msf1)', () => {
        expect(isHeicOrHeif(ftyp('msf1', ['hevc']))).toBe(true);
    });

    it('rejects a plain MP4 (isom), which is not HEIF', () => {
        expect(isHeicOrHeif(ftyp('isom', ['mp41', 'iso2']))).toBe(false);
    });

    it('rejects PNG and JPEG magic bytes', () => {
        expect(isHeicOrHeif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
        expect(isHeicOrHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    });

    it('rejects a too-short buffer', () => {
        expect(isHeicOrHeif(new Uint8Array([0x66, 0x74, 0x79, 0x70]))).toBe(false);
    });
});

describe('transcodeHeicToJpeg', () => {
    it('rejects non-HEIC input (so the launcher try/catch skips instead of crashing)', async () => {
        await expect(transcodeHeicToJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).rejects.toBeDefined();
    });
});

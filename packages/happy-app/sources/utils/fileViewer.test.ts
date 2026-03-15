import { describe, expect, it } from 'vitest';
import { getExtensionFromMimeType, getImageMimeType, isPreviewableImage } from './fileViewer';

describe('fileViewer utils', () => {
    it('recognizes supported preview image extensions', () => {
        expect(isPreviewableImage('/tmp/a.png')).toBe(true);
        expect(isPreviewableImage('/tmp/a.jpg')).toBe(true);
        expect(isPreviewableImage('/tmp/a.jpeg')).toBe(true);
        expect(isPreviewableImage('/tmp/a.gif')).toBe(true);
        expect(isPreviewableImage('/tmp/a.webp')).toBe(true);
    });

    it('supports uppercase and mixed-case extensions', () => {
        expect(isPreviewableImage('/tmp/A.PNG')).toBe(true);
        expect(isPreviewableImage('/tmp/B.JpEg')).toBe(true);
    });

    it('rejects unsupported or missing extensions', () => {
        expect(isPreviewableImage('/tmp/a.svg')).toBe(false);
        expect(isPreviewableImage('/tmp/a.pdf')).toBe(false);
        expect(isPreviewableImage('/tmp/a')).toBe(false);
        expect(isPreviewableImage('')).toBe(false);
    });

    it('returns correct image MIME type for supported extensions', () => {
        expect(getImageMimeType('/tmp/a.png')).toBe('image/png');
        expect(getImageMimeType('/tmp/a.jpg')).toBe('image/jpeg');
        expect(getImageMimeType('/tmp/a.jpeg')).toBe('image/jpeg');
        expect(getImageMimeType('/tmp/a.gif')).toBe('image/gif');
        expect(getImageMimeType('/tmp/a.webp')).toBe('image/webp');
    });

    it('returns null MIME type for unsupported files', () => {
        expect(getImageMimeType('/tmp/a.svg')).toBeNull();
        expect(getImageMimeType('/tmp/a.txt')).toBeNull();
        expect(getImageMimeType('/tmp/a')).toBeNull();
    });

    it('returns correct extension for supported MIME types', () => {
        expect(getExtensionFromMimeType('image/png')).toBe('png');
        expect(getExtensionFromMimeType('image/jpeg')).toBe('jpg');
        expect(getExtensionFromMimeType('image/gif')).toBe('gif');
        expect(getExtensionFromMimeType('image/webp')).toBe('webp');
    });

    it('returns png as fallback for unknown MIME types', () => {
        expect(getExtensionFromMimeType('image/bmp')).toBe('png');
        expect(getExtensionFromMimeType('application/pdf')).toBe('png');
    });
});

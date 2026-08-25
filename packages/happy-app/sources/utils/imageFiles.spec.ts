import { describe, expect, it } from 'vitest';
import { imageDataUri, imageMimeType, isImagePath } from './imageFiles';

describe('imageMimeType', () => {
    it('recognises the formats the platform can decode', () => {
        expect(imageMimeType('assets/logo.png')).toBe('image/png');
        expect(imageMimeType('a/b/photo.JPG')).toBe('image/jpeg');
        expect(imageMimeType('anim.gif')).toBe('image/gif');
        expect(imageMimeType('hero.webp')).toBe('image/webp');
    });

    it('leaves SVG to the text renderer, where it diffs properly', () => {
        expect(imageMimeType('icons/close.svg')).toBeNull();
    });

    it('says no when there is nothing to go on', () => {
        expect(imageMimeType('Makefile')).toBeNull();
        expect(imageMimeType('src/png')).toBeNull();
        expect(imageMimeType('archive.png.bak')).toBeNull();
    });
});

describe('isImagePath', () => {
    it('agrees with the mime lookup', () => {
        expect(isImagePath('a.png')).toBe(true);
        expect(isImagePath('a.ts')).toBe(false);
    });
});

describe('imageDataUri', () => {
    it('builds a data URI the loader accepts', () => {
        expect(imageDataUri('logo.png', 'AAAA')).toBe('data:image/png;base64,AAAA');
    });

    it('strips the newlines a shell pipeline wraps base64 with', () => {
        // `... | base64` wraps at 76 columns; the decoder rejects the breaks.
        expect(imageDataUri('logo.png', 'AAAA\nBBBB\n')).toBe('data:image/png;base64,AAAABBBB');
    });

    it('returns null rather than an empty image', () => {
        expect(imageDataUri('logo.png', '')).toBeNull();
        expect(imageDataUri('logo.png', '\n  \n')).toBeNull();
        expect(imageDataUri('notes.txt', 'AAAA')).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';
import { selectFileViewerSharePayload } from './fileViewerShare';

describe('selectFileViewerSharePayload', () => {
    it('returns image payload for image preview on app platforms', () => {
        const payload = selectFileViewerSharePayload({
            platform: 'ios',
            imageBase64: 'abc',
            imageMimeType: 'image/png',
            fileContent: null,
            diffContent: null,
        });

        expect(payload).toEqual({ kind: 'image', base64: 'abc', mimeType: 'image/png' });
    });

    it('falls back to text payload on web even with image data', () => {
        const payload = selectFileViewerSharePayload({
            platform: 'web',
            imageBase64: 'abc',
            imageMimeType: 'image/png',
            fileContent: { content: 'hello' },
            diffContent: null,
        });

        expect(payload).toEqual({ kind: 'text', text: 'hello' });
    });

    it('returns text payload for file content first, then diff', () => {
        expect(selectFileViewerSharePayload({
            platform: 'android',
            imageBase64: null,
            imageMimeType: 'image/png',
            fileContent: { content: 'file-text' },
            diffContent: 'diff-text',
        })).toEqual({ kind: 'text', text: 'file-text' });

        expect(selectFileViewerSharePayload({
            platform: 'android',
            imageBase64: null,
            imageMimeType: 'image/png',
            fileContent: null,
            diffContent: 'diff-text',
        })).toEqual({ kind: 'text', text: 'diff-text' });
    });

    it('returns none payload when nothing can be shared', () => {
        const payload = selectFileViewerSharePayload({
            platform: 'android',
            imageBase64: null,
            imageMimeType: 'image/png',
            fileContent: null,
            diffContent: null,
        });

        expect(payload).toEqual({ kind: 'none' });
    });
});

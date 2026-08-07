import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { configuration } from '@/configuration';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import {
    buildCodexImageAttachmentNotice,
    buildCodexInput,
    buildCodexTurnPayload,
    detectCodexImage,
    materializeCodexImageItems,
} from './codexImageInput';

// Minimal valid magic-byte headers padded out to a few bytes.
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GARBAGE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

function att(data: Uint8Array, name = 'pic', mimeType = 'application/octet-stream'): PendingAttachment {
    return { data, name, mimeType };
}

const written: string[] = [];
afterEach(() => {
    for (const p of written) {
        try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    written.length = 0;
});

describe('detectCodexImage', () => {
    it('detects the four supported formats by magic bytes, ignoring claimed mimeType', () => {
        expect(detectCodexImage(PNG)?.mime).toBe('image/png');
        expect(detectCodexImage(JPEG)?.mime).toBe('image/jpeg');
        expect(detectCodexImage(GIF)?.mime).toBe('image/gif');
        expect(detectCodexImage(WEBP)?.mime).toBe('image/webp');
    });

    it('returns null for bytes that match no supported format', () => {
        expect(detectCodexImage(GARBAGE)).toBeNull();
        expect(detectCodexImage(new Uint8Array([]))).toBeNull();
    });
});

describe('materializeCodexImageItems', () => {
    it('writes each supported image to the staging dir and returns localImage items', () => {
        const items = materializeCodexImageItems([att(PNG, 'shot.heic'), att(JPEG, 'photo')], '2026-01-01T00:00:00Z');
        expect(items).toHaveLength(2);
        for (const item of items) {
            expect(item.type).toBe('localImage');
            expect(item.path.startsWith(configuration.attachmentsDir)).toBe(true);
            expect(existsSync(item.path)).toBe(true);
            written.push(item.path);
        }
        // Extension reflects the sniffed type, not the (misleading) original name.
        expect(items[0].path.endsWith('.png')).toBe(true);
        expect(items[1].path.endsWith('.jpg')).toBe(true);
        // The staged bytes are the originals, untouched.
        expect(new Uint8Array(readFileSync(items[0].path))).toEqual(PNG);
    });

    it('skips unsupported attachments instead of throwing', () => {
        const items = materializeCodexImageItems([att(GARBAGE, 'evil.png'), att(GIF, 'ok')], '2026-01-01T00:00:00Z');
        expect(items).toHaveLength(1);
        expect(items[0].path.endsWith('.gif')).toBe(true);
        written.push(items[0].path);
    });
});

describe('buildCodexInput', () => {
    it('puts images first, then the text item', () => {
        const input = buildCodexInput('hello', [att(PNG, 'a'), att(JPEG, 'b')], );
        expect(input).toHaveLength(3);
        expect(input[0].type).toBe('localImage');
        expect(input[1].type).toBe('localImage');
        expect(input[2]).toEqual({ type: 'text', text: 'hello' });
        for (const it of input) {
            if (it.type === 'localImage') written.push(it.path);
        }
    });

    it('returns just the text item when there are no attachments', () => {
        expect(buildCodexInput('hi', undefined)).toEqual([{ type: 'text', text: 'hi' }]);
        expect(buildCodexInput('hi', [])).toEqual([{ type: 'text', text: 'hi' }]);
    });
});

describe('buildCodexTurnPayload', () => {
    it('delivers the staged video path in the prompt sent to Codex', () => {
        const video: PendingAttachment = {
            kind: 'video',
            localPath: '/Users/jacky/.happy/attachments/current-upload.mp4',
            size: 1_522_082,
            mimeType: 'video/mp4',
            name: 'current-upload.mp4',
        };

        const payload = buildCodexTurnPayload('inspect this interaction', [video]);

        expect(payload.images).toEqual([]);
        expect(payload.prompt).toContain('/Users/jacky/.happy/attachments/current-upload.mp4');
        expect(payload.prompt).toContain('Video 1');
        expect(payload.prompt).toContain('inspect this interaction');
    });

    it('preserves image delivery while adding the video notice', () => {
        const video: PendingAttachment = {
            kind: 'video',
            localPath: '/Users/jacky/.happy/attachments/current-upload.mp4',
            size: 1_522_082,
            mimeType: 'video/mp4',
            name: 'current-upload.mp4',
        };

        const payload = buildCodexTurnPayload('compare both attachments', [att(PNG, 'reference.png'), video]);

        expect(payload.images).toHaveLength(1);
        written.push(payload.images[0].path);
        expect(payload.prompt).toContain('Happy attached 1 user-uploaded image');
        expect(payload.prompt).toContain('/Users/jacky/.happy/attachments/current-upload.mp4');
        expect(payload.prompt).toContain('compare both attachments');
    });
});

describe('buildCodexImageAttachmentNotice', () => {
    it('tells Codex to use the exact staged image paths instead of guessing recent files', () => {
        const notice = buildCodexImageAttachmentNotice([
            { type: 'localImage', path: '/Users/jacky/.happy/attachments/current-upload.png' },
        ]);

        expect(notice).toContain('Happy attached 1 user-uploaded image');
        expect(notice).toContain('/Users/jacky/.happy/attachments/current-upload.png');
        expect(notice).toContain('Do not infer the intended upload by scanning ~/.happy/attachments');
    });

    it('returns null when no image is attached', () => {
        expect(buildCodexImageAttachmentNotice([])).toBeNull();
    });
});

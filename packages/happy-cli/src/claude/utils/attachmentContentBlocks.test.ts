import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from './attachmentContentBlocks';

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]); // "%PDF-1.4"
const TEXT = new TextEncoder().encode('hello\nworld');
const BINARY = new Uint8Array([0x00, 0xFF, 0x13, 0x37, 0x00, 0x01]);

describe('attachmentsToContentBlocks', () => {
    it('converts a PNG to an image block', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: PNG, mimeType: 'image/png', name: 'shot.png' }], 'look');
        expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
        expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: 'look' });
    });

    it('converts a PDF to a document block regardless of declared mime', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: PDF, mimeType: 'application/octet-stream', name: 'doc.pdf' }], 'read');
        expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    });

    it('inlines text/* attachments as fenced text blocks with filename', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: TEXT, mimeType: 'text/plain', name: 'log.txt' }], 'check');
        expect(blocks[0].type).toBe('text');
        const text = (blocks[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('log.txt');
        expect(text).toContain('hello\nworld');
    });

    it('inlines UTF-8 attachments with unknown mime by extension fallback', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: TEXT, mimeType: 'application/octet-stream', name: 'notes.md' }], 'check');
        expect(blocks[0].type).toBe('text');
    });

    it('emits a visible notice for unsupported binary attachments', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: BINARY, mimeType: 'application/octet-stream', name: 'blob.bin' }], 'hi');
        const last = blocks[blocks.length - 1] as { type: 'text'; text: string };
        expect(last.type).toBe('text');
        expect(last.text).toContain('blob.bin');
        expect(last.text).toContain('not a supported');
        expect(last.text).toContain('hi');
    });

    it('returns a single text block when there are no attachments', () => {
        expect(attachmentsToContentBlocks([], 'just text'))
            .toEqual([{ type: 'text', text: 'just text' }]);
    });

    it('skips HEIC bytes that fail magic detection (defense in depth)', () => {
        const heicish = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // ftyp box, no JPEG/PNG magic
        const blocks = attachmentsToContentBlocks(
            [{ data: heicish, mimeType: 'image/heic', name: 'pic.heic' }], 'hi');
        const last = blocks[blocks.length - 1] as { type: 'text'; text: string };
        expect(last.text).toContain('pic.heic');
    });
});

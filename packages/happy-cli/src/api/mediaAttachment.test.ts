import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import {
    isPlaintextMediaEvent,
    resolveMediaKind,
    stagedMediaPath,
    formatMediaAttachmentNotice,
    isMediaFileEvent,
    buildMediaAttachmentFromBytes,
    cleanupMediaAttachments,
    type MediaFileEvent,
} from './mediaAttachment';
import { buildCodexInput } from '@/codex/codexImageInput';
import { isMediaAttachment, type MediaAttachment, type PendingAttachment } from '@/utils/MessageQueue2';

const ev = (over: Partial<MediaFileEvent>): MediaFileEvent => ({
    ref: 'r',
    name: 'file.bin',
    size: 100,
    ...over,
});

describe('isPlaintextMediaEvent', () => {
    it('only opts in on explicit encrypted:false (back-compat with legacy images)', () => {
        expect(isPlaintextMediaEvent(ev({ encrypted: false }))).toBe(true);
        expect(isPlaintextMediaEvent(ev({ encrypted: true }))).toBe(false);
        expect(isPlaintextMediaEvent(ev({}))).toBe(false); // missing → encrypted image path
    });
});

describe('resolveMediaKind', () => {
    it('trusts wire kind first', () => {
        expect(resolveMediaKind(ev({ kind: 'audio', mimeType: 'video/mp4' }))).toBe('audio');
    });
    it('falls back to mimeType prefix', () => {
        expect(resolveMediaKind(ev({ mimeType: 'audio/mpeg', name: 'x' }))).toBe('audio');
        expect(resolveMediaKind(ev({ mimeType: 'video/mp4', name: 'x' }))).toBe('video');
    });
    it('falls back to extension, else defaults to video', () => {
        expect(resolveMediaKind(ev({ name: 'voice.mp3' }))).toBe('audio');
        expect(resolveMediaKind(ev({ name: 'clip.mkv' }))).toBe('video');
        expect(resolveMediaKind(ev({ name: 'noext' }))).toBe('video');
    });
    it('preserves the generic file kind for PDF documents', () => {
        expect(resolveMediaKind(ev({ kind: 'file' as any, mimeType: 'application/pdf', name: 'plan.pdf' }))).toBe('file');
    });
});

describe('stagedMediaPath', () => {
    it('keeps extension, sanitises name, and includes a stable ref-derived collision key', () => {
        const p = stagedMediaPath(ev({ name: 'my clip!.mp4' }), '2026-07-13T00:00:00.000Z', 2);
        expect(p).toMatch(/2026-07-13T00-00-00-000Z-2-[a-f0-9]{12}-my_clip_\.mp4$/);
    });
    it('handles names without extension', () => {
        const p = stagedMediaPath(ev({ name: 'recording' }), '2026-01-01T00:00:00Z', 0);
        expect(p).toMatch(/2026-01-01T00-00-00Z-0-[a-f0-9]{12}-recording$/);
    });
    it('does not collide for same-name files received in the same millisecond', () => {
        const first = stagedMediaPath(ev({ ref: 'attachment-a', name: 'plan.pdf' }), '2026-08-08T00:00:00.000Z', 0);
        const second = stagedMediaPath(ev({ ref: 'attachment-b', name: 'plan.pdf' }), '2026-08-08T00:00:00.000Z', 0);
        expect(first).not.toBe(second);
    });
});

describe('formatMediaAttachmentNotice', () => {
    const media = (over: Partial<MediaAttachment>): MediaAttachment => ({
        kind: 'video',
        localPath: '/tmp/x.mp4',
        size: 210 * 1024 * 1024,
        mimeType: 'video/mp4',
        name: 'x.mp4',
        ...over,
    });

    it('returns null with no media', () => {
        expect(formatMediaAttachmentNotice([])).toBeNull();
    });
    it('lists each path with human size and a tool hint', () => {
        const notice = formatMediaAttachmentNotice([
            media({}),
            media({ kind: 'audio', localPath: '/tmp/v.mp3', mimeType: 'audio/mpeg', size: 3 * 1024 * 1024 }),
        ]);
        expect(notice).toContain('/tmp/x.mp4');
        expect(notice).toContain('210.0MB');
        expect(notice).toContain('/tmp/v.mp3');
        expect(notice).toContain('3.0MB');
        expect(notice).toMatch(/ffmpeg|whisper/);
    });
    it('lists PDF paths as directly readable files', () => {
        const notice = formatMediaAttachmentNotice([
            media({
                kind: 'file' as any,
                localPath: '/tmp/floor-plan.pdf',
                mimeType: 'application/pdf',
                size: 2 * 1024 * 1024,
                name: 'floor-plan.pdf',
            }),
        ]);
        expect(notice).toContain('File 1: /tmp/floor-plan.pdf');
        expect(notice).toContain('Use the exact local file path');
        expect(notice).not.toContain('无法直接读取音视频内容');
    });
});

describe('isMediaFileEvent', () => {
    it('detects by kind or mimeType, false for images', () => {
        expect(isMediaFileEvent(ev({ kind: 'audio' }))).toBe(true);
        expect(isMediaFileEvent(ev({ mimeType: 'video/mp4' }))).toBe(true);
        expect(isMediaFileEvent(ev({ mimeType: 'image/png' }))).toBe(false);
        expect(isMediaFileEvent(ev({}))).toBe(false);
    });
    it('detects generic PDF file events without treating images as files', () => {
        expect(isMediaFileEvent(ev({ kind: 'file' as any, mimeType: 'application/pdf' }))).toBe(true);
        expect(isMediaFileEvent(ev({ mimeType: 'application/pdf', name: 'plan.pdf' }))).toBe(true);
        expect(isMediaFileEvent(ev({ mimeType: 'image/png', name: 'plan.png' }))).toBe(false);
    });
});

describe('buildMediaAttachmentFromBytes', () => {
    it('writes decrypted bytes to disk and returns a MediaAttachment with the path', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const att = await buildMediaAttachmentFromBytes(
            ev({ name: 'voice.mp3', mimeType: 'audio/mpeg', kind: 'audio' }),
            bytes,
            '2026-07-13T00:00:00Z',
            0,
        );
        expect(att.kind).toBe('audio');
        expect(att.size).toBe(5);
        expect(att.mimeType).toBe('audio/mpeg');
        expect(att.localPath).toMatch(/voice\.mp3$/);
        const written = await readFile(att.localPath);
        expect(Array.from(written)).toEqual([1, 2, 3, 4, 5]);
        await cleanupMediaAttachments([att]);
    });
    it('stages a decrypted PDF with its original extension', async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const att = await buildMediaAttachmentFromBytes(
            ev({ name: 'floor-plan.pdf', mimeType: 'application/pdf', kind: 'file' as any }),
            bytes,
            '2026-08-08T00:00:00Z',
            0,
        );
        expect(att.kind).toBe('file');
        expect(att.localPath).toMatch(/floor-plan\.pdf$/);
        expect(new Uint8Array(await readFile(att.localPath))).toEqual(bytes);
        expect((await stat(att.localPath)).mode & 0o777).toBe(0o600);
        await cleanupMediaAttachments([att]);
        await expect(readFile(att.localPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('buildCodexInput with media attachments', () => {
    it('injects media path notice into text, no localImage for media', () => {
        const attachments: PendingAttachment[] = [
            { kind: 'video', localPath: '/tmp/clip.mp4', size: 1234, mimeType: 'video/mp4', name: 'clip.mp4' },
        ];
        const input = buildCodexInput('transcribe this', attachments);
        // No localImage items produced for media
        expect(input.filter((i) => i.type === 'localImage')).toHaveLength(0);
        const text = input.find((i) => i.type === 'text') as { type: 'text'; text: string };
        expect(text.text).toContain('/tmp/clip.mp4');
        expect(text.text).toContain('transcribe this');
    });
    it('injects the exact PDF path into Codex text input', () => {
        const pdf = {
            kind: 'file' as any,
            localPath: '/tmp/floor-plan.pdf',
            size: 2048,
            mimeType: 'application/pdf',
            name: 'floor-plan.pdf',
        } as PendingAttachment;
        expect(isMediaAttachment(pdf)).toBe(true);
        if (!isMediaAttachment(pdf)) return;
        const attachments: PendingAttachment[] = [pdf];
        const input = buildCodexInput('review this plan', attachments);
        expect(input.filter((item) => item.type === 'localImage')).toHaveLength(0);
        expect(input).toContainEqual(expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('/tmp/floor-plan.pdf'),
        }));
    });
});

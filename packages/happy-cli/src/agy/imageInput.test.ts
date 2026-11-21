import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { FileEventMessage } from '@/api/types';
import {
  cleanupAgyImageCacheDir,
  downloadAgyFileEventAttachment,
  prepareAgyImagePrompt,
  resolveAgyImageCacheDir,
} from './imageInput';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeFileEvent(overrides?: Partial<FileEventMessage['content']['data']['ev']>): FileEventMessage {
  return {
    content: {
      t: 'file',
      data: {
        id: 'evt-1',
        seq: 1,
        time: 1000,
        ev: {
          t: 'file',
          ref: 'ref-1',
          name: 'screenshot.png',
          size: PNG_BYTES.length,
          mimeType: 'image/png',
          ...overrides,
        },
      },
    },
  } as unknown as FileEventMessage;
}

describe('downloadAgyFileEventAttachment', () => {
  it('downloads and decrypts a file event attachment', async () => {
    const session = {
      downloadAndDecryptAttachment: vi.fn(async () => PNG_BYTES),
    };
    await expect(downloadAgyFileEventAttachment(session, makeFileEvent())).resolves.toEqual({
      data: PNG_BYTES,
      mimeType: 'image/png',
      name: 'screenshot.png',
    });
  });

  it('returns null when decryption returns null or throws', async () => {
    const nullSession = {
      downloadAndDecryptAttachment: vi.fn(async () => null),
    };
    await expect(downloadAgyFileEventAttachment(nullSession, makeFileEvent())).resolves.toBeNull();

    const throwingSession = {
      downloadAndDecryptAttachment: vi.fn(async () => {
        throw new Error('network error');
      }),
    };
    await expect(downloadAgyFileEventAttachment(throwingSession, makeFileEvent())).resolves.toBeNull();
  });
});

describe('resolveAgyImageCacheDir', () => {
  it('sanitizes session ids to stay within cacheRootDir', () => {
    const resolved = resolveAgyImageCacheDir({
      sessionId: '../../escape/attempt',
      cacheRootDir: '/tmp/happy-agy-test',
    });
    expect(resolved.startsWith('/tmp/happy-agy-test/')).toBe(true);
    expect(resolved).not.toContain('..');
  });
});

describe('prepareAgyImagePrompt', () => {
  it('writes validated images to disk, formats read_file paths, and supports image-only messages', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'agy-img-test-'));
    try {
      const prepared = await prepareAgyImagePrompt({
        message: '',
        sessionId: 'sess-123',
        cacheRootDir: root,
        attachments: [
          { data: PNG_BYTES, mimeType: 'image/png', name: 'shot1.png' },
          { data: JPEG_BYTES, mimeType: 'image/jpeg', name: 'shot2.jpg' },
          { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: 'application/pdf', name: 'doc.pdf' },
        ],
      });

      expect(prepared.imagePaths).toHaveLength(2);
      expect(prepared.skipped).toBe(1);
      expect(prepared.cacheDir).toBe(join(root, 'sess-123'));
      expect(prepared.imagePaths[0]).toMatch(/\.png$/);
      expect(prepared.imagePaths[1]).toMatch(/\.jpg$/);
      expect(new Uint8Array(await readFile(prepared.imagePaths[0]))).toEqual(PNG_BYTES);
      expect(prepared.prompt).toContain('read_file');
      expect(prepared.prompt).toContain(prepared.imagePaths[0]);
      expect(prepared.prompt).toContain('Inspect the attached image(s)');

      await cleanupAgyImageCacheDir({ sessionId: 'sess-123', cacheRootDir: root });
      expect(existsSync(prepared.cacheDir!)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves user text alongside attached image paths', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'agy-img-text-'));
    try {
      const prepared = await prepareAgyImagePrompt({
        message: 'Why is this button misaligned?',
        sessionId: 'sess-456',
        cacheRootDir: root,
        attachments: [{ data: PNG_BYTES, mimeType: 'image/png', name: 'ui.png' }],
      });
      expect(prepared.prompt).toContain(prepared.imagePaths[0]);
      expect(prepared.prompt.endsWith('Why is this button misaligned?')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

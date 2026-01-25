import { describe, expect, test, vi } from 'vitest';

describe('createSessionAttachFile', () => {
  test('writes a 0600 attach file under HAPPY_HOME_DIR and cleanup deletes it', async () => {
    const { mkdtemp, readFile, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve, sep } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'happy-home-'));
    process.env.HAPPY_HOME_DIR = dir;
    const baseDir = resolve(join(dir, 'tmp', 'session-attach'));

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');
    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: 'happy-session-1',
      payload: { encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);

    const raw = await readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      encryptionKeyBase64: key,
      encryptionVariant: 'dataKey',
    });

    if (process.platform !== 'win32') {
      const s = await stat(filePath);
      expect(s.mode & 0o077).toBe(0);
    }

    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();
  });

  test('prevents path traversal in happySessionId (always stays within base dir)', async () => {
    const { mkdtemp, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { basename, join, resolve, sep } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'happy-home-'));
    process.env.HAPPY_HOME_DIR = dir;
    const baseDir = resolve(join(dir, 'tmp', 'session-attach'));

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');

    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: '../evil',
      payload: { encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);
    expect(basename(filePath).startsWith('..')).toBe(false);

    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();

    // Ensure the base directory still exists (we didn't clobber parent dirs).
    await expect(stat(join(dir, 'tmp', 'session-attach'))).resolves.toBeTruthy();
  });
});

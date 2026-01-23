import { describe, expect, it } from 'vitest';
import * as tmp from 'tmp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from './terminalAttachmentInfo';

describe('terminalAttachmentInfo', () => {
  it('writes and reads per-session terminal attachment info', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_123',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:win-1', tmpDir: '/tmp/happy-tmux' },
        },
      });

      const raw = await readFile(join(dir.name, 'terminal', 'sessions', 'sess_123.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe('sess_123');
      expect(parsed.terminal?.tmux?.target).toBe('happy:win-1');

      const info = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_123',
      });
      expect(info?.terminal.mode).toBe('tmux');
      expect(info?.terminal.tmux?.tmpDir).toBe('/tmp/happy-tmux');
    } finally {
      dir.removeCallback();
    }
  });

  it('stores sessionId using a filename-safe encoding to prevent path traversal', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = '../evil/session';
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: {
          mode: 'plain',
          plain: { command: 'echo hi', cwd: '/tmp' },
        } as any,
      });

      const encodedFileName = `${encodeURIComponent(sessionId)}.json`;
      const raw = await readFile(join(dir.name, 'terminal', 'sessions', encodedFileName), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe(sessionId);

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info?.sessionId).toBe(sessionId);
    } finally {
      dir.removeCallback();
    }
  });

  it('can still read legacy files created with the raw sessionId filename', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'tmux:legacy';
      await mkdir(join(dir.name, 'terminal', 'sessions'), { recursive: true });
      const legacyPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.json`);
      await writeFile(legacyPath, JSON.stringify({
        version: 1,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:win-1', tmpDir: '/tmp/happy-tmux' } },
        updatedAt: Date.now(),
      }, null, 2), 'utf8');

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info?.terminal.mode).toBe('tmux');
      expect(info?.terminal.tmux?.target).toBe('happy:win-1');
    } finally {
      dir.removeCallback();
    }
  });

  it('does not read legacy files when sessionId contains path separators', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = '../../pwned';
      await mkdir(join(dir.name, 'terminal', 'sessions'), { recursive: true });

      // If the legacy path fallback were used for this sessionId, it would resolve outside the sessions dir.
      // Ensure we don't read it even if such a file exists.
      const traversedPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.json`);
      await writeFile(traversedPath, JSON.stringify({
        version: 1,
        sessionId,
        terminal: { mode: 'plain', plain: { command: 'echo hi', cwd: '/tmp' } },
        updatedAt: Date.now(),
      }, null, 2), 'utf8');

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info).toBeNull();
    } finally {
      dir.removeCallback();
    }
  });
});

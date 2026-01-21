import { describe, expect, it } from 'vitest';
import * as tmp from 'tmp';
import { readFile } from 'node:fs/promises';
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
});


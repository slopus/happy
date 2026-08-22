import { describe, expect, it } from 'vitest';

import {
  buildHappyTerminalBootCommand,
  HAPPY_TERMINAL_BOOT_TIMEOUT_MS,
} from './happyTerminalBoot';

describe('Happy Terminal daemon boot', () => {
  it('builds a node command for the exported daemon entrypoint', () => {
    expect(buildHappyTerminalBootCommand('/installed/happy-terminal/dist/main.js', '/usr/bin/node'))
      .toEqual({
        command: '/usr/bin/node',
        args: ['/installed/happy-terminal/dist/main.js', 'daemon', 'start'],
      });
  });

  it('uses a bounded best-effort startup timeout', () => {
    expect(HAPPY_TERMINAL_BOOT_TIMEOUT_MS).toBe(120_000);
  });
});
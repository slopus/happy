import { describe, expect, it, vi } from 'vitest';

import {
  buildHappyTerminalBootCommand,
  HAPPY_TERMINAL_BOOT_TIMEOUT_MS,
  startHappyTerminalDaemon,
} from './happyTerminalBoot';

vi.mock('@/configuration', () => ({ configuration: { bootHappyAgent: false } }));
// The logger opens real log files off the configuration this test replaces.
vi.mock('@/ui/logger', () => ({ logger: { debug: () => undefined } }));

describe('Happy Terminal daemon boot', () => {
  it('starts nothing for somebody who never asked for Happy Agent', () => {
    const child = startHappyTerminalDaemon();

    // A second daemon on the machine is opted into. Returning null here is what keeps an
    // ordinary CLI upgrade from registering a second machine on the person's account.
    expect(child).toBeNull();
  });

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
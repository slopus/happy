import { describe, expect, it, vi } from 'vitest';

const { mockConfiguration, mockSpawn } = vi.hoisted(() => ({
  mockConfiguration: { bootHappyAgent: false } as { bootHappyAgent: boolean },
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: () => '/installed/happy-terminal/dist/main.js' }),
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));
// The logger opens real log files off the configuration this test replaces.
vi.mock('@/ui/logger', () => ({ logger: { debug: () => undefined } }));

import {
  buildHappyTerminalBootCommand,
  HAPPY_TERMINAL_BOOT_TIMEOUT_MS,
  startHappyTerminalDaemon,
} from './happyTerminalBoot';

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

  it('hides the daemon child window on Windows', () => {
    const child = {
      stdout: null,
      stderr: null,
      once: vi.fn(),
    };
    mockConfiguration.bootHappyAgent = true;
    mockSpawn.mockReturnValue(child);

    expect(startHappyTerminalDaemon()).toBe(child);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/installed/happy-terminal/dist/main.js', 'daemon', 'start'],
      expect.objectContaining({ windowsHide: true }),
    );
  });
});

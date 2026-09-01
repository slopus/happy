import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

describe('daemon control server ownership', () => {
  let stopServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stopServer?.();
    stopServer = undefined;
    vi.restoreAllMocks();
  });

  it('rejects a stop request bound to a predecessor generation', async () => {
    const requestShutdown = vi.fn();
    const server = await startDaemonControlServer({
      ownerToken: 'generation-h',
      getChildren: () => [],
      stopSession: () => false,
      spawnSession: vi.fn(),
      requestShutdown,
      onHappySessionWebhook: vi.fn(),
    });
    stopServer = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedOwnerToken: 'generation-g' }),
    });
    expect(response.status).toBe(409);
    expect(requestShutdown).not.toHaveBeenCalled();
  });
});

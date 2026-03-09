import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonControlServer } from './controlServer';
import { TrackedSession } from './types';
import { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

describe('startDaemonControlServer', () => {
  let stopServer: (() => Promise<void>) | null = null;
  const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({
    type: 'success',
    sessionId: 'alive'
  }));

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
    spawnSession.mockClear();
  });

  it('prunes stale sessions before listing children', async () => {
    const children: TrackedSession[] = [
      { startedBy: 'daemon', happySessionId: 'alive', pid: 111 },
      { startedBy: 'daemon', pid: 222 }
    ];
    const pruneStaleSessions = vi.fn(() => {
      children.splice(1, 1);
      return 1;
    });

    const server = await startDaemonControlServer({
      getChildren: () => children,
      pruneStaleSessions,
      stopSession: vi.fn(() => true),
      spawnSession,
      requestShutdown: vi.fn(),
      onHappySessionWebhook: vi.fn()
    });
    stopServer = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });

    expect(response.ok).toBe(true);
    expect(pruneStaleSessions).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      children: [
        {
          startedBy: 'daemon',
          happySessionId: 'alive',
          pid: 111
        }
      ]
    });
  });

  it('prunes stale sessions before stopping a session', async () => {
    const pruneStaleSessions = vi.fn(() => 1);
    const stopSession = vi.fn(() => true);

    const server = await startDaemonControlServer({
      getChildren: () => [],
      pruneStaleSessions,
      stopSession,
      spawnSession,
      requestShutdown: vi.fn(),
      onHappySessionWebhook: vi.fn()
    });
    stopServer = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/stop-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'alive' })
    });

    expect(response.ok).toBe(true);
    expect(pruneStaleSessions).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith('alive');
    await expect(response.json()).resolves.toEqual({ success: true });
  });
});

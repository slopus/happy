import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonControlServer } from './controlServer';
import { checkIfDaemonRunningAndCleanupStaleState, spawnDaemonSession, stopDaemonHttp } from './controlClient';
import { readDaemonState } from '@/persistence';

vi.mock('@/persistence', () => ({ readDaemonState: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

it('protects all control callbacks and accepts authenticated local callers', async () => {
  const callbacks = {
    getChildren: vi.fn(() => []), stopSession: vi.fn(), onHappySessionWebhook: vi.fn(),
    spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'test' })),
    requestShutdown: vi.fn(), getConnectionStatus: vi.fn(),
  };
  const { app, controlToken } = createDaemonControlServer(callbacks);
  try {
    for (const url of ['/status', '/list', '/stop', '/spawn-session', '/stop-session', '/session-started']) {
      for (const headers of [{}, { authorization: `Bearer ${'x'.repeat(controlToken.length)}` }]) {
        const r = await app.inject({ method: 'POST', url, headers, payload: { directory: '.', sessionId: 'test', metadata: {} } });
        expect(r.statusCode).toBe(401);
      }
    }
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();

    // Exercise the real client and routes in memory, without starting a listener or a process.
    const state = { httpPort: 12345, pid: process.pid, startTime: '', startedWithCliVersion: '', controlToken };
    vi.mocked(readDaemonState).mockResolvedValue(state);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      const r = await app.inject({ method: 'POST', url: new URL(url).pathname,
        headers: Object.fromEntries(new Headers(init.headers)), payload: String(init.body) });
      return new Response(r.body, { status: r.statusCode });
    });
    vi.stubGlobal('fetch', fetch);
    const options = { agent: 'openclaw' as const, environmentVariables: { PROJECT_LABEL: 'test' } };
    expect(await spawnDaemonSession('.', undefined, options)).toMatchObject({ success: true });
    expect(callbacks.spawnSession).toHaveBeenCalledWith(expect.objectContaining(options));
    expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(true);
    vi.mocked(readDaemonState).mockResolvedValue({ ...state, controlToken: '0'.repeat(64) });
    await expect(stopDaemonHttp()).rejects.toThrow('did not accept');
    expect(fetch).toHaveBeenCalledTimes(3); // No tokenless retry after a 401
    vi.mocked(readDaemonState).mockResolvedValue({ ...state, controlToken: undefined });
    expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
    expect(await spawnDaemonSession('.')).toHaveProperty('error');
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(stopDaemonHttp()).rejects.toThrow('did not accept');
    expect(fetch.mock.calls[3][1]).toMatchObject({ body: '{}', redirect: 'error' });
    expect(new Headers(fetch.mock.calls[3][1].headers).has('Authorization')).toBe(false);
    expect(callbacks.requestShutdown).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
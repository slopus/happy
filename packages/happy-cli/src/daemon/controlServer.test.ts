import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonControlServer } from './controlServer';

describe('startDaemonControlServer', () => {
  let stopServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
  });

  it('forwards resume ids from local spawn requests', async () => {
    const spawnSession = vi.fn().mockResolvedValue({
      type: 'success',
      sessionId: 'happy-session-123',
    });
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => false,
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
    });
    stopServer = stop;

    const response = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: '/repo',
        agent: 'claude',
        resumeClaudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
      }),
    });

    expect(response.ok).toBe(true);
    expect(spawnSession).toHaveBeenCalledWith({
      directory: '/repo',
      agent: 'claude',
      resumeClaudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
      sessionId: undefined,
      environmentVariables: undefined,
    });
  });

  it('validates and forwards Codex model and effort from local spawn requests', async () => {
    const spawnSession = vi.fn().mockResolvedValue({
      type: 'success',
      sessionId: 'happy-session-123',
    });
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => false,
      spawnSession,
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
    });
    stopServer = stop;

    const response = await fetch(`http://127.0.0.1:${port}/spawn-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: '/repo',
        agent: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'low',
      }),
    });

    expect(response.ok).toBe(true);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      agent: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'low',
    }));
  });
  it('validates and dispatches an independent task with its parent context', async () => {
    const launchIndependentSession = vi.fn(async () => ({ success: true, sessionId: 'child', title: 'Task' }));
    const { port, stop } = await startDaemonControlServer({
      getChildren: () => [], stopSession: () => false, spawnSession: vi.fn(),
      launchIndependentSession, requestShutdown: () => {}, onHappySessionWebhook: () => {},
    });
    stopServer = stop;
    const task = { requestId: 'id', title: 'Task', prompt: 'Read files' };
    const context = { permissionMode: 'read-only', appendSystemPrompt: 'User custom instructions' };
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/independent-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(await (await post({ parentSessionId: 'parent', ...task, context })).json()).toEqual({ success: true, sessionId: 'child', title: 'Task' });
    expect(launchIndependentSession).toHaveBeenCalledWith('parent', task, context);
    expect((await post({ parentSessionId: 'parent', ...task, prompt: '' })).status).toBe(400);
    expect(launchIndependentSession).toHaveBeenCalledTimes(1);
  });

});

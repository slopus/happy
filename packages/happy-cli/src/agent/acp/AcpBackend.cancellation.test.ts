import { describe, expect, it, vi } from 'vitest';
import { AcpBackend } from './AcpBackend';
import type { AgentMessage } from '@/agent/core';

function connectedBackend(connection: { prompt: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }) {
  const backend = new AcpBackend({ agentName: 'antigravity', cwd: '/tmp', command: '/unused' });
  Reflect.set(backend, 'connection', connection);
  Reflect.set(backend, 'acpSessionId', 'native-session');
  const messages: AgentMessage[] = [];
  backend.onMessage(message => messages.push(message));
  return { backend, messages };
}

describe('ACP native cancellation', () => {
  it('awaits the exact native prompt termination and retains the backend for another prompt', async () => {
    let finish!: (value: { stopReason: string }) => void;
    const nativePrompt = new Promise(resolve => { finish = resolve; });
    const connection = { prompt: vi.fn().mockReturnValueOnce(nativePrompt).mockResolvedValue({ stopReason: 'end_turn' }), cancel: vi.fn().mockResolvedValue(undefined) };
    const { backend, messages } = connectedBackend(connection);
    const prompt = backend.sendPrompt('logical-session', 'first task');
    let cancelled = false;
    const cancellation = backend.cancel('logical-session').then(() => { cancelled = true; });
    await Promise.resolve();
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'native-session' });
    expect(cancelled).toBe(false);
    expect(messages).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));
    finish({ stopReason: 'cancelled' });
    await Promise.all([prompt, cancellation]);
    expect(cancelled).toBe(true);
    expect(messages).toContainEqual({ type: 'event', name: 'prompt_cancelled', payload: {} });
    expect(messages).toContainEqual({ type: 'status', status: 'idle' });
    expect(messages).not.toContainEqual(expect.objectContaining({ status: 'stopped' }));
    await backend.sendPrompt('logical-session', 'revise the same task');
    expect(connection.prompt).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation transport failure without emitting a stopped or cancelled state', async () => {
    const { backend, messages } = connectedBackend({ prompt: vi.fn(), cancel: vi.fn().mockRejectedValue(new Error('cancel transport failed')) });
    await expect(backend.cancel('logical-session')).rejects.toThrow('cancel transport failed');
    expect(messages).toEqual([]);
  });

  it('does not emit cancelled when the requested native prompt completes naturally', async () => {
    let finish!: (value: { stopReason: string }) => void;
    const nativePrompt = new Promise(resolve => { finish = resolve; });
    const { backend, messages } = connectedBackend({ prompt: vi.fn().mockReturnValue(nativePrompt), cancel: vi.fn().mockResolvedValue(undefined) });
    const prompt = backend.sendPrompt('logical-session', 'task');
    const cancellation = backend.cancel('logical-session');
    finish({ stopReason: 'end_turn' });
    await Promise.all([prompt, cancellation]);
    expect(messages.some(message => message.type === 'event' && message.name === 'prompt_cancelled')).toBe(false);
    expect(messages.some(message => message.type === 'status' && message.status === 'stopped')).toBe(false);
  });

  it('rejects unavailable sessions instead of reporting cancellation success', async () => {
    const backend = new AcpBackend({ agentName: 'antigravity', cwd: '/tmp', command: '/unused' });
    await expect(backend.cancel('unknown')).rejects.toThrow('not available');
  });
});

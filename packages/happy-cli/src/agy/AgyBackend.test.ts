import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AgyBackend, type SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';

/** Minimal fake of a spawned child process for driving AgyBackend in tests. */
function makeFakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: (signal?: string) => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  return { child, stdout, stderr };
}

describe('AgyBackend', () => {
  it('maps a successful turn: running → model-output(s) → idle', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');

    // Stream two chunks then exit cleanly.
    stdout.emit('data', 'Hello ');
    stdout.emit('data', 'world');
    child.emit('close', 0);

    await expect(turn).resolves.toBeUndefined();

    const types = messages.map((m) => m.type);
    expect(types[0]).toBe('status');
    expect(messages[0]).toMatchObject({ type: 'status', status: 'running' });
    // agy --print hangs unless stdin is closed: spawn must give the child an
    // empty stdin (immediate EOF), not an open pipe.
    const spawnOpts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(spawnOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'Hello ' },
      { type: 'model-output', textDelta: 'world' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('emits an error status and rejects on non-zero exit', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');
    child.emit('close', 1);

    await expect(turn).rejects.toThrow(/exited with code 1/);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'error' });
  });

  it('resumes the captured conversation id on the next turn', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    // No conversation at start; agy records one after the first turn.
    let recorded: string | null = null;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    // First turn: fresh (no --conversation), then a conversation id appears.
    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'cid-xyz';
    current.child.emit('close', 0);
    await t1;

    expect(spawnCalls[0]).not.toContain('--conversation');

    // Second turn: resumes the captured id.
    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('cid-xyz');
  });
});

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
  child.kill = vi.fn(() => true);
  return { child, stdout, stderr };
}

describe('AgyBackend', () => {
  it('maps a successful turn: running → stream-json events → idle', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');

    // Emit init, chunks, result, then close
    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-123","init":{"cwd":"/work"}}\n',
    );
    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Hello "}}\n',
    );
    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-123","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"world"}}\n',
    );
    stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-123","status":"SUCCESS"}}\n',
    );
    child.emit('close', 0);

    await expect(turn).resolves.toBeUndefined();

    expect(messages[0]).toMatchObject({ type: 'status', status: 'running' });
    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'Hello ' },
      { type: 'model-output', textDelta: 'world' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
    expect(backend.getConversationId()).toBe('c-123');
  });

  it('captures conversation ID from init event and resumes it on next turn', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    const discoveredIds: string[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      onConversationId: (id) => discoveredIds.push(id),
    });

    await backend.startSession();

    // Turn 1: fresh (no --conversation)
    const t1 = backend.sendPrompt('/work', 'first');
    current.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"cid-discovered-abc"}\n',
    );
    current.child.emit('close', 0);
    await t1;

    expect(spawnCalls[0]).not.toContain('--conversation');
    expect(discoveredIds).toEqual(['cid-discovered-abc']);
    expect(backend.getConversationId()).toBe('cid-discovered-abc');

    // Turn 2: resumes the captured id
    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.stdout.emit(
      'data',
      '{"event":"init","conversation_id":"cid-discovered-abc"}\n',
    );
    current.child.emit('close', 0);
    await t2;

    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('cid-discovered-abc');
  });

  it('resumes pre-existing conversation ID passed in constructor', async () => {
    const spawnCalls: string[][] = [];
    const { child } = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return child;
    }) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      conversationId: 'resumed-cid-999',
      spawnFn,
    });

    await backend.startSession();
    const t1 = backend.sendPrompt('/work', 'hello');
    child.emit('close', 0);
    await t1;

    const idx = spawnCalls[0].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[0][idx + 1]).toBe('resumed-cid-999');
  });

  it('maps tool calls and tool results from step_update', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'list files');

    stdout.emit(
      'data',
      '{"event":"init","conversation_id":"c-123"}\n' +
      '{"event":"step_update","step_update":{"conversation_id":"c-123","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}}\n' +
      '{"event":"step_update","step_update":{"conversation_id":"c-123","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"file.txt"}}}\n',
    );
    child.emit('close', 0);

    await expect(turn).resolves.toBeUndefined();

    expect(messages).toContainEqual({
      type: 'tool-call',
      callId: 'agy-step-2',
      toolName: 'run_command',
      args: { CommandLine: 'ls' },
    });
    expect(messages).toContainEqual({
      type: 'tool-result',
      callId: 'agy-step-2',
      toolName: 'run_command',
      result: 'file.txt',
    });
  });

  it('maps reasoning/process steps to thinking events', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'think');

    stdout.emit(
      'data',
      '{"event":"step_update","step_update":{"conversation_id":"c-123","step_index":1,"state":"ACTIVE","step_type":"reasoning","text_delta":"Deep thoughts..."}}\n',
    );
    child.emit('close', 0);

    await expect(turn).resolves.toBeUndefined();

    expect(messages).toContainEqual({
      type: 'event',
      name: 'thinking',
      payload: {
        text: 'Deep thoughts...',
        streaming: true,
      },
    });
  });

  it('emits error status and rejects on non-zero exit or error result', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'fail');

    stdout.emit(
      'data',
      '{"event":"result","result":{"conversation_id":"c-123","status":"ERROR","error":"Token quota exceeded"}}\n',
    );
    child.emit('close', 1);

    await expect(turn).rejects.toThrow(/Token quota exceeded/);
    expect(messages.at(-1)).toMatchObject({
      type: 'status',
      status: 'error',
      detail: 'Token quota exceeded',
    });
  });

  it('cancels child process via SIGTERM', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
    });

    await backend.startSession();
    void backend.sendPrompt('/work', 'long running');

    await backend.cancel();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('updates model and permissionMode dynamically between turns', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      model: 'Gemini 3.1 Pro (High)',
      spawnFn,
    });

    await backend.startSession();

    // Turn 1: default mode
    const t1 = backend.sendPrompt('/work', 'turn 1');
    current.child.emit('close', 0);
    await t1;

    expect(spawnCalls[0]).toContain('--sandbox');
    expect(spawnCalls[0]).toContain('Gemini 3.1 Pro (High)');

    // Switch settings
    backend.setPermissionMode('bypassPermissions');
    backend.setModel('Gemini 3.7 Flash (High)');

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'turn 2');
    current.child.emit('close', 0);
    await t2;

    expect(spawnCalls[1]).toContain('--dangerously-skip-permissions');
    expect(spawnCalls[1]).toContain('Gemini 3.7 Flash (High)');
  });
});

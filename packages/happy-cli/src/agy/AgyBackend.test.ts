import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AgyBackend, type SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';

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
  it('maps a successful turn: running → one complete terminal response → idle', async () => {
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

    // Split NDJSON records across arbitrary stdout chunks.
    stdout.emit('data', '{"event":"init","conversation_id":"c1"}\n{"event":"step_update","step_update":{"step_type":"agent_response","text_');
    stdout.emit('data', 'delta":"Hello "}}\n{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"world"}}\n{"event":"result","result":{"status":"SUCCESS","response":"Hello world"}}\n');
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
      { type: 'model-output', textDelta: 'Hello world' },
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('ignores response fragments and emits result.response exactly once', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'split frag' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ment' } })}\n`);
    const result = `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'split fragment' } })}\n`;
    stdout.emit('data', result);
    stdout.emit('data', result);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'split fragment' },
    ]);
  });

  it('produces one intact Happy text envelope after fragmented agy output', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();
    backend.onMessage((message) => envelopes.push(...mapper.mapMessage(message)));

    const turn = backend.sendPrompt('/work', 'hi');
    const deltas = ['# Head', 'ing\n', '* first', ' item\n', '* second item'];
    for (const text_delta of deltas) {
      stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } })}\n`);
    }
    const response = deltas.join('');
    stdout.emit('data', `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } })}\n`);
    child.emit('close', 0);
    await turn;
    envelopes.push(...mapper.endTurn('completed'));

    const textEnvelopes = envelopes.filter((envelope) => envelope.ev.t === 'text');
    expect(textEnvelopes).toHaveLength(1);
    expect(textEnvelopes[0].ev).toEqual({ t: 'text', text: response });
    expect(envelopes.at(-1)?.ev).toMatchObject({ t: 'turn-end', status: 'completed' });
  });

  it('maps tool lifecycle records with paired ids and useful inputs', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'list_dir',
        tool_info: { parameters: { DirectoryPath: '/work/tasks', token: 'nope' } },
      },
    })}\n`);
    stdout.emit('data', `${JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'list_dir',
        tool_info: { parameters: { DirectoryPath: '/work/tasks' }, output: 'private listing' },
      },
    })}\n`);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'tool-call' || m.type === 'tool-result')).toEqual([
      { type: 'tool-call', toolName: 'LS', callId: 'agy:1:2', args: { path: '/work/tasks' } },
      { type: 'tool-result', toolName: 'LS', callId: 'agy:1:2', result: { status: 'DONE' } },
    ]);
    expect(JSON.stringify(messages)).not.toContain('private listing');
    expect(JSON.stringify(messages)).not.toContain('nope');
  });

  it('maps file and command cards while hiding credential-bearing commands', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const secrets = [
      'header-secret-123',
      'flag-secret-123',
      'env-secret-123',
      'url-secret-123',
      'json-secret-123',
      'curl-user-secret-123',
      'multiline-secret-123',
      'escaped-secret-123',
    ];
    const commands = [
      `curl -H "Authorization: Bearer ${secrets[0]}"`,
      `--token=${secrets[1]}`,
      `TOKEN=${secrets[2]}`,
      `https://user:${secrets[3]}@example.test/path`,
      `--data '{"client_secret":"${secrets[4]}"}'`,
      `curl -u user:${secrets[5]} https://example.test`,
      `cat <<EOF\npassword: ${secrets[6]}\nEOF`,
      String.raw`--client_secret='prefix\'${secrets[7]}'`,
    ];
    const records = [
      { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/work/package.json', StartLine: 1, EndLine: 20 } } },
      { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { output: secrets[0] } },
      { step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' } } },
      { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command' },
      ...commands.flatMap((CommandLine, index) => [
        { step_index: index + 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine } } },
        { step_index: index + 5, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: secrets[index] } } },
      ]),
    ];
    const turn = backend.sendPrompt('/work', 'hi');
    for (const step_update of records) {
      stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update })}\n`);
    }
    child.emit('close', 0);
    await turn;

    const calls = messages.filter((m) => m.type === 'tool-call');
    expect(calls[0]).toEqual({
      type: 'tool-call',
      toolName: 'Read',
      callId: 'agy:1:3',
      args: { file_path: '/work/package.json', offset: 1, limit: 20 },
    });
    expect(calls[1]).toMatchObject({
      type: 'tool-call',
      toolName: 'Bash',
      callId: 'agy:1:4',
      args: { command: 'pwd' },
    });
    for (const [index, call] of calls.slice(2).entries()) {
      expect(call).toMatchObject({ type: 'tool-call', toolName: 'Bash', callId: `agy:1:${index + 5}` });
      if (call?.type !== 'tool-call') throw new Error('expected run_command call');
      expect(call.args.command, `command ${index}`).toBe('[redacted command]');
    }
    for (const secret of secrets) expect(JSON.stringify(messages)).not.toContain(secret);
  });

  it('copies only known scalar tool fields', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const parameters = JSON.parse('{"DirectoryPath":{"safe":{"next":{"tooDeep":"hidden"}},"__proto__":{"polluted":true}},"Unexpected":"hidden"}');
    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { parameters } },
    })}\n`);
    stdout.emit('data', `${JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 6, state: 'ACTIVE', step_type: 'tool', tool_name: 'grep_search', tool_info: { parameters: { Query: 'needle', SearchPath: Array.from({ length: 20 }, (_, index) => [index]) } } },
    })}\n`);
    stdout.emit('data', `${JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'unknown_tool', tool_info: { parameters: { CommandLine: 'echo visible' } } },
    })}\n`);
    child.emit('close', 0);
    await turn;

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('polluted');
    expect(serialized).not.toContain('tooDeep');
    expect(serialized).not.toContain('Unexpected');
    const grepCall = messages.find((message) => message.type === 'tool-call' && message.toolName === 'Grep');
    expect(grepCall).toMatchObject({ args: { pattern: 'needle' } });
    if (grepCall?.type !== 'tool-call') throw new Error('expected Grep call');
    expect(grepCall.args).not.toHaveProperty('path');
    expect(messages.filter((m) => m.type === 'tool-call').at(-1)).toMatchObject({ args: {} });
  });

  it('deduplicates repeated tool lifecycle records', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const active = { event: 'step_update', step_update: { step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { parameters: { DirectoryPath: '/work' } } } };
    const done = { event: 'step_update', step_update: { step_index: 7, state: 'DONE', step_type: 'tool', tool_name: 'list_dir' } };
    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify(active)}\n${JSON.stringify(active)}\n${JSON.stringify(done)}\n${JSON.stringify(done)}\n`);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'tool-call')).toHaveLength(1);
    expect(messages.filter((m) => m.type === 'tool-result')).toHaveLength(1);
  });

  it('logs malformed records and stderr without including their contents', async () => {
    const { child, stdout, stderr } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const log = vi.fn();
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, log, resolveConversationId: () => null });

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', 'secret-token\nunterminated-secret');
    stderr.emit('data', 'Authorization: Bearer stderr-secret');
    child.emit('close', 0);
    await turn;

    expect(log).toHaveBeenCalledWith('ignored malformed agy stream-json record (12 bytes)');
    expect(log).toHaveBeenCalledWith('ignored unterminated agy stream-json record (19 bytes)');
    expect(log).toHaveBeenCalledWith('agy stderr suppressed (35 bytes)');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  it('ignores valid non-object records and continues with the stream', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const log = vi.fn();
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, log, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', 'null\n42\n[]\n"hidden-string"\n');
    stdout.emit('data', `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'recovered' } })}\n`);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((message) => message.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'recovered' },
    ]);
    expect(log.mock.calls.flat().join(' ')).not.toContain('hidden-string');
    expect(log.mock.calls.filter(([entry]) => /^ignored non-object agy stream-json record \(\d+ bytes\)$/.test(entry))).toHaveLength(4);
  });

  it('drops oversized records, resumes at newline, and keeps payloads out of logs', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const log = vi.fn();
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, log, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `{"event":"ignored","payload":"${'x'.repeat(16 * 1024 * 1024)}secret`);
    stdout.emit('data', `\n${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'recovered' } })}\n`);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'recovered' },
    ]);
    expect(log).toHaveBeenCalledWith('ignored oversized agy stream-json record (>16777216 bytes)');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  it('uses a fixed failure message instead of forwarding result status', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({ event: 'result', result: { status: 'secret-status' } })}\n`);
    child.emit('close', 0);

    await expect(turn).rejects.toThrow('agy stream reported failure');
    expect(JSON.stringify(messages)).not.toContain('secret-status');
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

  it('starts fresh instead of resuming a pre-existing cwd conversation (cross-resume guard)', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    // The cwd cache already holds a conversation from another (possibly live) session.
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => 'other-sessions-conversation',
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    current.child.emit('close', 0);
    await t1;
    expect(spawnCalls[0]).not.toContain('--conversation');

    // The cache entry never changed, so it was not ours to adopt.
    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;
    expect(spawnCalls[1]).not.toContain('--conversation');
  });

  it('adopts the id recorded during the first turn even when a stale entry existed', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = 'stale-old';
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'fresh-1'; // our turn created a new conversation
    current.child.emit('close', 0);
    await t1;
    expect(spawnCalls[0]).not.toContain('--conversation');

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;
    const idx = spawnCalls[1].indexOf('--conversation');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[1][idx + 1]).toBe('fresh-1');
  });

  it('re-snapshots the cache every turn while unpinned: a foreign write between turns is not adopted', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = 'stale-S';
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    // Turn 1: cache stays at the stale value → nothing to adopt.
    const t1 = backend.sendPrompt('/work', 'first');
    current.child.emit('close', 0);
    await t1;

    // While idle, a foreign session writes a new id. If the backend kept using
    // turn 1's snapshot ('stale-S'), turn 2's close would mis-adopt 'foreign-F'.
    recorded = 'foreign-F';

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    current = makeFakeChild();
    const t3 = backend.sendPrompt('/work', 'third');
    current.child.emit('close', 0);
    await t3;

    for (const call of spawnCalls) {
      expect(call).not.toContain('--conversation');
    }
  });

  it('keeps the pinned conversation when another session updates the cache', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    let recorded: string | null = null;
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => recorded,
    });

    await backend.startSession();

    const t1 = backend.sendPrompt('/work', 'first');
    recorded = 'mine';
    current.child.emit('close', 0);
    await t1;

    // A second agy session in the same cwd finishes a turn: cache now points elsewhere.
    recorded = 'theirs';

    current = makeFakeChild();
    const t2 = backend.sendPrompt('/work', 'second');
    current.child.emit('close', 0);
    await t2;

    current = makeFakeChild();
    const t3 = backend.sendPrompt('/work', 'third');
    current.child.emit('close', 0);
    await t3;

    for (const call of [spawnCalls[1], spawnCalls[2]]) {
      const idx = call.indexOf('--conversation');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(call[idx + 1]).toBe('mine');
    }
  });

  it('emits only one error when error is followed by close (no double-emit)', async () => {
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

    // Node fires both 'error' and 'close' on spawn failure.
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', null);

    await expect(turn).rejects.toThrow(/ENOENT/);
    expect(messages.filter((m) => m.type === 'status' && m.status === 'error')).toHaveLength(1);
  });

  it('cancel() kills the running child', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
    });

    await backend.startSession();
    const turn = backend.sendPrompt('/work', 'hi');
    await backend.cancel();
    expect(child.kill).toHaveBeenCalled();

    // The kill surfaces as a non-zero close, which rejects the turn.
    child.emit('close', null);
    await expect(turn).rejects.toThrow();
  });
});

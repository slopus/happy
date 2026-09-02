import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
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

  it('appends the Happy title instruction only to the first turn', async () => {
    const spawnCalls: string[][] = [];
    let current = makeFakeChild();
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      spawnCalls.push(args);
      return current.child;
    }) as unknown as SpawnFn;

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'yolo',
      spawnFn,
      resolveConversationId: () => null,
    });

    const firstTurn = backend.sendPrompt('/work', 'first task');
    current.child.emit('close', 0);
    await firstTurn;

    current = makeFakeChild();
    const secondTurn = backend.sendPrompt('/work', 'continue');
    current.child.emit('close', 0);
    await secondTurn;

    const promptFromArgs = (args: string[]) => {
      const printIndex = args.indexOf('--print');
      expect(printIndex).toBeGreaterThanOrEqual(0);
      return args[printIndex + 1];
    };

    expect(promptFromArgs(spawnCalls[0])).toBe(
      `first task\n\n${CHANGE_TITLE_INSTRUCTION}`,
    );
    expect(promptFromArgs(spawnCalls[1])).toBe('continue');
  });

  it('sets a safe fallback title without invoking the MCP tool in sandbox mode', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const onTitle = vi.fn();
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
      onTitle,
    });

    const turn = backend.sendPrompt(
      '/work',
      'Summarize the infrastructure repository purpose.',
    );
    child.emit('close', 0);
    await turn;

    expect(onTitle).toHaveBeenCalledWith(
      'Summarize the infrastructure repository purpose',
    );
    const args = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    const prompt = args[args.indexOf('--print') + 1];
    expect(prompt).toContain('Happy has already set the session title');
    expect(prompt).not.toContain('functions.happy__change_title');
  });

  it('bounds long fallback titles at a word boundary', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const onTitle = vi.fn();
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
      onTitle,
    });

    const turn = backend.sendPrompt(
      '/work',
      'Investigate why the Happy mobile application does not receive the final Agy response after setting its title',
    );
    child.emit('close', 0);
    await turn;

    const title = onTitle.mock.calls[0][0] as string;
    expect([...title].length).toBeLessThanOrEqual(60);
    expect(title).toMatch(/…$/);
  });

  it('passes the session-scoped Happy MCP URL to agy', async () => {
    const { child } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const env = {
      PATH: '/test/bin',
      HAPPY_HTTP_MCP_URL: 'http://127.0.0.1:43210',
    };
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      resolveConversationId: () => null,
      env,
    });

    const turn = backend.sendPrompt('/work', 'hi');
    child.emit('close', 0);
    await turn;

    expect(spawnFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ env }),
    );
  });

  it('buffers response fragments and does not duplicate the terminal aggregate', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'split frag' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'ment' } })}\n`);
    const result = `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'split fragment' } })}\n`;
    stdout.emit('data', result);
    stdout.emit('data', result);
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'model-output')).toEqual([
      { type: 'model-output', textDelta: 'split fragment' },
    ]);
  });

  it('emits intact progress before tools and final text after them', async () => {
    const { child, stdout } = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, resolveConversationId: () => null });
    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();
    backend.onMessage((message) => envelopes.push(...mapper.mapMessage(message)));

    const turn = backend.sendPrompt('/work', 'hi');
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '# Head' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'ing\n' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { parameters: { DirectoryPath: '/work' } } } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'list_dir' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '* first' } })}\n`);
    stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: ' item' } })}\n`);
    const response = '# Heading\n* first item';
    stdout.emit('data', `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } })}\n`);
    child.emit('close', 0);
    await turn;
    envelopes.push(...mapper.endTurn('completed'));

    const textEnvelopes = envelopes.filter((envelope) => envelope.ev.t === 'text');
    expect(textEnvelopes).toHaveLength(2);
    expect(textEnvelopes.map((envelope) => envelope.ev)).toEqual([
      { t: 'text', text: '# Heading' },
      { t: 'text', text: '* first item' },
    ]);
    expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
      'turn-start',
      'text',
      'tool-call-start',
      'tool-call-end',
      'text',
      'turn-end',
    ]);
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
    for (const step_update of [
      {
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'replace_file_content',
        tool_info: {
          parameters: {
            TargetFile: '/work/TODO.md',
            TargetContent: 'private old content',
            ReplacementContent: 'private replacement content',
          },
        },
      },
      { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'replace_file_content' },
      {
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { parameters: { TargetFile: '/work/new.md', CodeContent: 'private new content' } },
      },
      { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' },
      {
        step_index: 5,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'manage_task',
        tool_info: {
          parameters: {
            Action: 'status',
            TaskId: 'private-conversation-id/task-20',
            Input: 'private task input',
            toolSummary: 'private task summary',
          },
        },
      },
      {
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'manage_task',
        tool_info: { output: 'Task is still running' },
      },
      {
        step_index: 6,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'manage_task',
        tool_info: { parameters: { Action: 'kill', TaskId: 'private-conversation-id/task-30' } },
      },
      {
        step_index: 6,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'manage_task',
        tool_info: { output: 'Task killed' },
      },
      {
        step_index: 7,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: {
          parameters: {
            ServerName: 'happy',
            ToolName: 'change_title',
            Arguments: { title: 'private title' },
          },
        },
      },
      {
        step_index: 7,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { output: 'Title changed' },
      },
      {
        step_index: 8,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'search_web',
        tool_info: { parameters: { query: 'Agy documentation', toolSummary: 'private search summary' } },
      },
      {
        step_index: 8,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'search_web',
        tool_info: { output: 'Search result' },
      },
    ]) {
      stdout.emit('data', `${JSON.stringify({ event: 'step_update', step_update })}\n`);
    }
    child.emit('close', 0);
    await turn;

    expect(messages.filter((m) => m.type === 'tool-call' || m.type === 'tool-result')).toEqual([
      { type: 'tool-call', toolName: 'LS', callId: 'agy:1:2', args: { path: '/work/tasks' } },
      { type: 'tool-result', toolName: 'LS', callId: 'agy:1:2', result: { status: 'DONE' } },
      { type: 'tool-call', toolName: 'Edit', callId: 'agy:1:3', args: { file_path: '/work/TODO.md' } },
      { type: 'tool-result', toolName: 'Edit', callId: 'agy:1:3', result: { status: 'DONE' } },
      { type: 'tool-call', toolName: 'Write', callId: 'agy:1:4', args: { file_path: '/work/new.md' } },
      { type: 'tool-result', toolName: 'Write', callId: 'agy:1:4', result: { status: 'DONE' } },
      { type: 'tool-call', toolName: 'Bash', callId: 'agy:1:5', args: { command: 'manage_task status task-20' } },
      { type: 'tool-result', toolName: 'Bash', callId: 'agy:1:5', result: { status: 'DONE', stdout: 'Task is still running' } },
      { type: 'tool-call', toolName: 'Bash', callId: 'agy:1:6', args: { command: 'manage_task kill task-30' } },
      { type: 'tool-result', toolName: 'Bash', callId: 'agy:1:6', result: { status: 'DONE', stdout: 'Task killed' } },
      { type: 'tool-call', toolName: 'Bash', callId: 'agy:1:7', args: { command: 'mcp happy.change_title' } },
      { type: 'tool-result', toolName: 'Bash', callId: 'agy:1:7', result: { status: 'DONE', stdout: 'Title changed' } },
      { type: 'tool-call', toolName: 'WebSearch', callId: 'agy:1:8', args: { query: 'Agy documentation' } },
      { type: 'tool-result', toolName: 'WebSearch', callId: 'agy:1:8', result: { status: 'DONE', stdout: 'Search result' } },
    ]);
    expect(messages.filter((m) => m.type === 'event')).toEqual([
      { type: 'event', name: 'thinking', payload: { text: 'Task is still running', streaming: false } },
      { type: 'event', name: 'thinking', payload: { text: 'Task killed', streaming: false } },
      { type: 'event', name: 'thinking', payload: { text: 'Title changed', streaming: false } },
      { type: 'event', name: 'thinking', payload: { text: 'Search result', streaming: false } },
    ]);
    const mapper = new AcpSessionManager();
    const envelopes = mapper.startTurn();
    for (const message of messages) envelopes.push(...mapper.mapMessage(message));
    envelopes.push(...mapper.endTurn('completed'));
    expect(
      envelopes
        .filter((envelope) => envelope.ev.t === 'text' && envelope.ev.thinking)
        .map((envelope) => envelope.ev.t === 'text' ? envelope.ev.text : ''),
    ).toEqual(['Task is still running', 'Task killed', 'Title changed', 'Search result']);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('private listing');
    expect(serialized).not.toContain('private old content');
    expect(serialized).not.toContain('private replacement content');
    expect(serialized).not.toContain('private new content');
    expect(serialized).not.toContain('private-conversation-id');
    expect(serialized).not.toContain('private task input');
    expect(serialized).not.toContain('private task summary');
    expect(serialized).not.toContain('private title');
    expect(serialized).not.toContain('private search summary');
    expect(serialized).not.toContain('nope');
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
      { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'command output\n' } },
      ...commands.flatMap((CommandLine, index) => [
        { step_index: index + 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine } } },
        {
          step_index: index + 5,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { output: `token=${secrets[index]}`, error: { message: secrets[index] } },
        },
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
    expect(messages).toContainEqual({
      type: 'tool-result',
      toolName: 'Bash',
      callId: 'agy:1:4',
      result: { status: 'DONE', stdout: 'command output\n' },
    });
    for (const [index, call] of calls.slice(2).entries()) {
      expect(call).toMatchObject({ type: 'tool-call', toolName: 'Bash', callId: `agy:1:${index + 5}` });
      if (call?.type !== 'tool-call') throw new Error('expected run_command call');
      expect(call.args.command, `command ${index}`).toBe('[redacted command]');
    }
    for (const result of messages.filter((m) => m.type === 'tool-result').slice(2)) {
      expect(result).toMatchObject({ result: { status: 'ERROR', stderr: '[redacted output]' } });
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

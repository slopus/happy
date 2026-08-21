import { describe, expect, it, vi } from 'vitest';
import { StreamJsonParser } from './streamJson';
import type { AgentMessage } from '@/agent/core/AgentBackend';

describe('StreamJsonParser', () => {
  it('parses init event and triggers onInit', () => {
    const onInit = vi.fn();
    const parser = new StreamJsonParser({ onInit });

    parser.feed('{"event":"init","conversation_id":"cid-123","init":{"cwd":"/test"}}\n');

    expect(onInit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'init',
        conversation_id: 'cid-123',
        init: { cwd: '/test' },
      }),
    );
  });

  it('handles chunked feed across line boundaries', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    parser.feed('{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Hello ');
    expect(messages).toHaveLength(0);

    parser.feed('World!"}}\n');
    expect(messages).toEqual([
      { type: 'model-output', textDelta: 'Hello World!' },
    ]);
  });

  it('handles multiple events in a single chunk', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    const payload = [
      '{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Chunk 1"}}',
      '{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Chunk 2"}}',
      '{"event":"result","result":{"conversation_id":"cid-123","status":"SUCCESS","usage":{"total_tokens":100}}}',
    ].join('\n') + '\n';

    parser.feed(payload);

    expect(messages).toEqual([
      { type: 'model-output', textDelta: 'Chunk 1' },
      { type: 'model-output', textDelta: 'Chunk 2' },
      { type: 'token-count', total_tokens: 100 },
    ]);
  });

  it('parses tool calls and tool results', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    // Tool start
    parser.feed(
      '{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}\n',
    );

    expect(messages).toEqual([
      {
        type: 'tool-call',
        callId: 'agy-step-3',
        toolName: 'run_command',
        args: { CommandLine: 'ls -la' },
      },
    ]);

    // Tool end (escaped \n inside JSON)
    parser.feed(
      '{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","output":"file1.txt\\nfile2.txt"}}}\n',
    );

    expect(messages).toEqual([
      {
        type: 'tool-call',
        callId: 'agy-step-3',
        toolName: 'run_command',
        args: { CommandLine: 'ls -la' },
      },
      {
        type: 'tool-result',
        callId: 'agy-step-3',
        toolName: 'run_command',
        result: 'file1.txt\nfile2.txt',
      },
    ]);
  });

  it('parses reasoning/process events into thinking messages', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    parser.feed(
      '{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":1,"state":"ACTIVE","step_type":"reasoning","text_delta":"Analyzing the codebase..."}}\n',
    );

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'thinking',
        payload: {
          text: 'Analyzing the codebase...',
          streaming: true,
        },
      },
    ]);
  });

  it('emits error status on result ERROR status', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    parser.feed(
      '{"event":"result","result":{"conversation_id":"cid-123","status":"ERROR","error":"Model rate limit reached"}}\n',
    );

    expect(messages).toEqual([
      {
        type: 'status',
        status: 'error',
        detail: 'Model rate limit reached',
      },
    ]);
  });

  it('ignores non-JSON lines and logs them without crashing', () => {
    const logs: string[] = [];
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      log: (msg) => logs.push(msg),
      onMessage: (msg) => messages.push(msg),
    });

    parser.feed('Some initial banner text from startup\n');
    parser.feed('{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"OK"}}\n');

    expect(logs).toContain('non-json stdout: Some initial banner text from startup');
    expect(messages).toEqual([
      { type: 'model-output', textDelta: 'OK' },
    ]);
  });

  it('flushes trailing line on flush()', () => {
    const messages: AgentMessage[] = [];
    const parser = new StreamJsonParser({
      onMessage: (msg) => messages.push(msg),
    });

    parser.feed('{"event":"step_update","step_update":{"conversation_id":"cid-123","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Done"}}');
    expect(messages).toHaveLength(0);

    parser.flush();
    expect(messages).toEqual([
      { type: 'model-output', textDelta: 'Done' },
    ]);
  });
});

/**
 * Tests for acpx SessionMessage types.
 *
 * acpx types are plain TypeScript (not Zod). These tests verify:
 * - SessionMessage variant construction (User, Agent, Resume)
 * - SessionAgentContent variant handling (Text, Thinking, ToolUse)
 * - SessionToolUse + SessionToolResult matching
 * - Encryption round-trip with raw SessionMessage
 */

import { describe, it, expect } from 'vitest';
import { getRandomBytes, encryptMessage, decryptMessage, type KeyMaterial } from './encryption';
import type {
  SessionMessage,
  SessionUserMessage,
  SessionAgentMessage,
  SessionAgentContent,
  SessionToolUse,
  SessionToolResult,
  SessionTokenUsage,
  SessionAcpxState,
  SessionRecord,
} from './acpx-types';

function makeKeyMaterial(): KeyMaterial {
  return { key: getRandomBytes(32), variant: 'dataKey' };
}

// ─── SessionMessage variant construction ────────────────────────────────────

describe('SessionMessage variants', () => {
  it('constructs a User message', () => {
    const msg: SessionMessage = {
      User: { id: 'u1', content: [{ Text: 'hello' }] },
    };
    expect('User' in msg).toBe(true);
    expect((msg as { User: SessionUserMessage }).User.id).toBe('u1');
  });

  it('constructs an Agent message', () => {
    const msg: SessionMessage = {
      Agent: { content: [{ Text: 'hi' }], tool_results: {} },
    };
    expect('Agent' in msg).toBe(true);
    expect((msg as { Agent: SessionAgentMessage }).Agent.content).toHaveLength(1);
  });

  it('constructs a Resume message', () => {
    const msg: SessionMessage = 'Resume';
    expect(msg).toBe('Resume');
  });

  it('discriminates variants by key', () => {
    const user: SessionMessage = { User: { id: 'u1', content: [] } };
    const agent: SessionMessage = { Agent: { content: [], tool_results: {} } };
    const resume: SessionMessage = 'Resume';

    expect(typeof user).toBe('object');
    expect(typeof agent).toBe('object');
    expect(typeof resume).toBe('string');

    if (typeof user === 'object' && 'User' in user) {
      expect(user.User.id).toBe('u1');
    } else {
      throw new Error('Expected User variant');
    }
  });
});

// ─── SessionAgentContent variant handling ───────────────────────────────────

describe('SessionAgentContent variants', () => {
  it('handles Text content', () => {
    const content: SessionAgentContent = { Text: 'hello world' };
    expect('Text' in content).toBe(true);
  });

  it('handles Thinking content', () => {
    const content: SessionAgentContent = {
      Thinking: { text: 'reasoning...', signature: 'sig123' },
    };
    expect('Thinking' in content).toBe(true);
    expect((content as { Thinking: { text: string } }).Thinking.text).toBe('reasoning...');
  });

  it('handles Thinking without signature', () => {
    const content: SessionAgentContent = {
      Thinking: { text: 'reasoning...' },
    };
    expect('Thinking' in content).toBe(true);
  });

  it('handles RedactedThinking content', () => {
    const content: SessionAgentContent = { RedactedThinking: 'redacted' };
    expect('RedactedThinking' in content).toBe(true);
  });

  it('handles ToolUse content', () => {
    const toolUse: SessionToolUse = {
      id: 'tu1',
      name: 'Read',
      raw_input: '{"path": "/tmp/foo"}',
      input: { path: '/tmp/foo' },
      is_input_complete: true,
    };
    const content: SessionAgentContent = { ToolUse: toolUse };
    expect('ToolUse' in content).toBe(true);
    expect((content as { ToolUse: SessionToolUse }).ToolUse.name).toBe('Read');
  });
});

// ─── SessionToolUse + SessionToolResult matching ────────────────────────────

describe('SessionToolUse + SessionToolResult', () => {
  it('matches tool result to tool use by id', () => {
    const toolUse: SessionToolUse = {
      id: 'tu1',
      name: 'Bash',
      raw_input: '{"command": "ls"}',
      input: { command: 'ls' },
      is_input_complete: true,
    };
    const toolResult: SessionToolResult = {
      tool_use_id: 'tu1',
      tool_name: 'Bash',
      is_error: false,
      content: { Text: 'file1.txt\nfile2.txt' },
    };
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolResult.is_error).toBe(false);
  });

  it('represents error tool results', () => {
    const toolResult: SessionToolResult = {
      tool_use_id: 'tu2',
      tool_name: 'Write',
      is_error: true,
      content: { Text: 'Permission denied' },
    };
    expect(toolResult.is_error).toBe(true);
  });

  it('stores tool results in agent message keyed by tool_use_id', () => {
    const agentMsg: SessionAgentMessage = {
      content: [
        { ToolUse: { id: 'tu1', name: 'Read', raw_input: '{}', input: {}, is_input_complete: true } },
        { ToolUse: { id: 'tu2', name: 'Write', raw_input: '{}', input: {}, is_input_complete: true } },
      ],
      tool_results: {
        tu1: { tool_use_id: 'tu1', tool_name: 'Read', is_error: false, content: { Text: 'ok' } },
        tu2: { tool_use_id: 'tu2', tool_name: 'Write', is_error: true, content: { Text: 'fail' } },
      },
    };

    // Look up result for each tool use
    for (const item of agentMsg.content) {
      if ('ToolUse' in item) {
        const result = agentMsg.tool_results[item.ToolUse.id];
        expect(result).toBeDefined();
        expect(result.tool_use_id).toBe(item.ToolUse.id);
      }
    }
  });
});

// ─── Encryption round-trip ──────────────────────────────────────────────────

describe('Encryption round-trip with SessionMessage', () => {
  it('round-trips a User message', () => {
    const km = makeKeyMaterial();
    const original: SessionMessage = {
      User: { id: 'u1', content: [{ Text: 'hello' }] },
    };
    const encrypted = encryptMessage(km, original);
    const decrypted = decryptMessage(km, encrypted) as SessionMessage;
    expect(decrypted).toEqual(original);
  });

  it('round-trips an Agent message with tool results', () => {
    const km = makeKeyMaterial();
    const original: SessionMessage = {
      Agent: {
        content: [
          { Text: 'Let me read that file.' },
          { ToolUse: { id: 'tu1', name: 'Read', raw_input: '{"path":"/a"}', input: { path: '/a' }, is_input_complete: true } },
        ],
        tool_results: {
          tu1: { tool_use_id: 'tu1', tool_name: 'Read', is_error: false, content: { Text: 'contents' } },
        },
      },
    };
    const encrypted = encryptMessage(km, original);
    const decrypted = decryptMessage(km, encrypted) as SessionMessage;
    expect(decrypted).toEqual(original);
  });

  it('round-trips a Resume message', () => {
    const km = makeKeyMaterial();
    const original: SessionMessage = 'Resume';
    const encrypted = encryptMessage(km, original);
    const decrypted = decryptMessage(km, encrypted) as SessionMessage;
    expect(decrypted).toEqual(original);
  });
});

// ─── SessionAcpxState and SessionTokenUsage ─────────────────────────────────

describe('Session metadata types', () => {
  it('constructs SessionTokenUsage', () => {
    const usage: SessionTokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    };
    expect(usage.input_tokens).toBe(100);
  });

  it('constructs SessionAcpxState', () => {
    const state: SessionAcpxState = {
      current_mode_id: 'code',
      current_model_id: 'claude-sonnet-4-6',
      available_models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      available_commands: ['/help', '/compact'],
    };
    expect(state.current_model_id).toBe('claude-sonnet-4-6');
    expect(state.available_models).toHaveLength(2);
  });
});

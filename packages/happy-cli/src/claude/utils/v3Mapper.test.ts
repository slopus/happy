import { describe, it, expect } from 'vitest';
import { handleClaudeMessage, createV3MapperState, flushV3Turn } from './v3Mapper';
import type { RawJSONLines } from '@/claude/types';

function makeState() {
  return createV3MapperState({
    sessionID: 'ses_test',
    agent: 'build',
    modelID: 'claude-sonnet-4-6',
    providerID: 'anthropic',
    cwd: '/test/project',
    root: '/test/project',
  });
}

function userMsg(text: string): RawJSONLines {
  return {
    type: 'user',
    uuid: `uuid_${Math.random().toString(36).slice(2)}`,
    message: { content: text },
  } as any;
}

function assistantTextMsg(text: string): RawJSONLines {
  return {
    type: 'assistant',
    uuid: `uuid_${Math.random().toString(36).slice(2)}`,
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-4-6',
    },
  } as any;
}

function assistantThinkingMsg(thinking: string): RawJSONLines {
  return {
    type: 'assistant',
    uuid: `uuid_${Math.random().toString(36).slice(2)}`,
    message: {
      content: [{ type: 'thinking', thinking }],
      usage: { input_tokens: 50, output_tokens: 20 },
    },
  } as any;
}

function assistantToolMsg(toolName: string, toolId: string, input: Record<string, unknown>): RawJSONLines {
  return {
    type: 'assistant',
    uuid: `uuid_${Math.random().toString(36).slice(2)}`,
    message: {
      content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
      usage: { input_tokens: 200, output_tokens: 100 },
    },
  } as any;
}

function userToolResultMsg(toolId: string, output: string, isError = false): RawJSONLines {
  return {
    type: 'user',
    uuid: `uuid_${Math.random().toString(36).slice(2)}`,
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolId, content: output, is_error: isError }],
    },
  } as any;
}

describe('v3Mapper', () => {
  describe('basic text turn', () => {
    it('builds assistant message with text part', () => {
      const state = makeState();

      // User sends prompt
      const r1 = handleClaudeMessage(userMsg('Hello'), state);
      expect(r1.messages).toHaveLength(1);
      expect(r1.messages[0].info.role).toBe('user');
      expect(r1.messages[0].parts).toHaveLength(1);
      expect(r1.messages[0].parts[0].type).toBe('text');

      // Assistant responds
      const r2 = handleClaudeMessage(assistantTextMsg('Hi there!'), state);
      expect(r2.messages).toHaveLength(0); // not finalized yet
      expect(r2.currentAssistant).not.toBeNull();
      expect(r2.currentAssistant!.parts.some((p: any) => p.type === 'text')).toBe(true);

      // Flush (end of session or next user message)
      const flushed = flushV3Turn(state);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].info.role).toBe('assistant');
      const info = flushed[0].info;
      expect(info.role).toBe('assistant');
      if (info.role === 'assistant') expect(info.finish).toBe('stop');
      expect(flushed[0].parts.some((p: any) => p.type === 'step-start')).toBe(true);
      expect(flushed[0].parts.some((p: any) => p.type === 'step-finish')).toBe(true);
    });
  });

  describe('reasoning', () => {
    it('creates reasoning part from thinking blocks', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Think about this'), state);
      handleClaudeMessage(assistantThinkingMsg('Let me think...'), state);

      const flushed = flushV3Turn(state);
      expect(flushed).toHaveLength(1);
      const reasoning = flushed[0].parts.find(p => p.type === 'reasoning');
      expect(reasoning).toBeDefined();
      if (reasoning?.type === 'reasoning') {
        expect(reasoning.text).toBe('Let me think...');
      }
    });
  });

  describe('tool calls', () => {
    it('creates tool part with running state', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Create a file'), state);
      const r = handleClaudeMessage(assistantToolMsg('writeFile', 'call_1', { path: 'test.txt', content: 'hello' }), state);

      expect(r.currentAssistant).not.toBeNull();
      const toolPart = r.currentAssistant!.parts.find((p: any) => p.type === 'tool');
      expect(toolPart).toBeDefined();
      if (toolPart?.type === 'tool') {
        expect(toolPart.tool).toBe('writeFile');
        expect(toolPart.state.status).toBe('running');
        expect(toolPart.callID).toBe('call_1');
      }
    });

    it('completes tool part when tool result arrives', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Create a file'), state);
      handleClaudeMessage(assistantToolMsg('writeFile', 'call_1', { path: 'test.txt' }), state);

      // Tool result arrives as the next user message
      const r = handleClaudeMessage(userToolResultMsg('call_1', 'Created test.txt'), state);

      // The user tool result finalizes the previous assistant turn
      const finalized = r.messages.find((m: any) => m.info.role === 'assistant');
      expect(finalized).toBeDefined();
      if (finalized) {
        const toolPart = finalized.parts.find((p: any) => p.type === 'tool');
        expect(toolPart).toBeDefined();
        if (toolPart?.type === 'tool') {
          expect(toolPart.state.status).toBe('completed');
          if (toolPart.state.status === 'completed') {
            expect(toolPart.state.output).toBe('Created test.txt');
          }
        }
        if (finalized.info.role === 'assistant') expect(finalized.info.finish).toBe('tool-calls');
      }
    });

    it('marks tool as error when is_error=true', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Run command'), state);
      handleClaudeMessage(assistantToolMsg('bash', 'call_2', { command: 'bad_cmd' }), state);

      const r = handleClaudeMessage(userToolResultMsg('call_2', 'command not found', true), state);
      const finalized = r.messages.find((m: any) => m.info.role === 'assistant');
      expect(finalized).toBeDefined();
      if (finalized) {
        const toolPart = finalized.parts.find((p: any) => p.type === 'tool');
        if (toolPart?.type === 'tool') {
          expect(toolPart.state.status).toBe('error');
        }
      }
    });
  });

  describe('multi-step turn', () => {
    it('handles text + tool + more text in sequence', () => {
      const state = makeState();

      handleClaudeMessage(userMsg('Read file and summarize'), state);
      handleClaudeMessage(assistantTextMsg('Let me read the file.'), state);
      handleClaudeMessage(assistantToolMsg('readFile', 'call_3', { path: 'README.md' }), state);

      // Tool result → finalizes first assistant message
      const r1 = handleClaudeMessage(userToolResultMsg('call_3', 'File contents here'), state);
      expect(r1.messages.some((m: any) => m.info.role === 'assistant')).toBe(true);

      // Second assistant message with summary
      handleClaudeMessage(assistantTextMsg('Here is the summary.'), state);
      const flushed = flushV3Turn(state);
      expect(flushed).toHaveLength(1);
      if (flushed[0].info.role === 'assistant') expect(flushed[0].info.finish).toBe('stop');
    });
  });

  describe('token tracking', () => {
    it('accumulates tokens across assistant messages in a turn', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Hello'), state);
      handleClaudeMessage(assistantTextMsg('Response 1'), state); // 100 in, 50 out
      handleClaudeMessage(assistantTextMsg('Response 2'), state); // 100 in, 50 out

      const flushed = flushV3Turn(state);
      expect(flushed).toHaveLength(1);
      if (flushed[0].info.role === 'assistant') {
        expect(flushed[0].info.tokens.input).toBe(200);
        expect(flushed[0].info.tokens.output).toBe(100);
      }
    });
  });

  describe('system messages', () => {
    it('updates session ID from system message', () => {
      const state = makeState();
      handleClaudeMessage({ type: 'system', uuid: 'sys_1', sessionId: 'ses_new' } as any, state);
      expect(state.sessionID).toBe('ses_new');
    });
  });

  describe('summary messages', () => {
    it('ignores summary messages', () => {
      const state = makeState();
      const r = handleClaudeMessage({ type: 'summary', summary: 'test', leafUuid: 'x' } as any, state);
      expect(r.messages).toHaveLength(0);
    });
  });

  describe('part ordering', () => {
    it('produces step-start, reasoning/text/tool, step-finish in order', () => {
      const state = makeState();
      handleClaudeMessage(userMsg('Do stuff'), state);
      handleClaudeMessage(assistantThinkingMsg('thinking...'), state);
      handleClaudeMessage(assistantTextMsg('doing stuff'), state);

      const flushed = flushV3Turn(state);
      const parts = flushed[0].parts;
      expect(parts[0].type).toBe('step-start');
      expect(parts[parts.length - 1].type).toBe('step-finish');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { KimiTransport, KIMI_TIMEOUTS } from './KimiTransport';

describe('KimiTransport', () => {
  const transport = new KimiTransport();

  describe('agentName', () => {
    it('returns kimi', () => {
      expect(transport.agentName).toBe('kimi');
    });
  });

  describe('getInitTimeout', () => {
    it('returns 60 seconds', () => {
      expect(transport.getInitTimeout()).toBe(60_000);
    });
  });

  describe('filterStdoutLine', () => {
    it('keeps valid JSON object lines', () => {
      const line = '{"jsonrpc":"2.0","id":1,"result":{}}';
      expect(transport.filterStdoutLine(line)).toBe(line);
    });

    it('keeps valid JSON array lines', () => {
      const line = '[{"jsonrpc":"2.0"}]';
      expect(transport.filterStdoutLine(line)).toBe(line);
    });

    it('drops empty lines', () => {
      expect(transport.filterStdoutLine('')).toBeNull();
      expect(transport.filterStdoutLine('  ')).toBeNull();
    });

    it('drops non-JSON lines', () => {
      expect(transport.filterStdoutLine('Starting Kimi...')).toBeNull();
      expect(transport.filterStdoutLine('Loading model...')).toBeNull();
    });

    it('drops lines that parse as JSON primitives', () => {
      expect(transport.filterStdoutLine('42')).toBeNull();
      expect(transport.filterStdoutLine('"hello"')).toBeNull();
      expect(transport.filterStdoutLine('true')).toBeNull();
    });

    it('drops invalid JSON that starts with {', () => {
      expect(transport.filterStdoutLine('{invalid')).toBeNull();
    });
  });

  describe('handleStderr', () => {
    const emptyContext = { activeToolCalls: new Set<string>(), hasActiveInvestigation: false };

    it('suppresses empty stderr', () => {
      const result = transport.handleStderr('', emptyContext);
      expect(result.message).toBeNull();
      expect(result.suppress).toBe(true);
    });

    it('detects rate limit errors', () => {
      const result = transport.handleStderr('Error: status 429 Too Many Requests', emptyContext);
      expect(result.message).toBeNull();
      expect(result.suppress).toBe(false);
    });

    it('detects auth errors and emits error status', () => {
      const result = transport.handleStderr('Error: 401 Unauthorized', emptyContext);
      expect(result.message).not.toBeNull();
      expect(result.message?.type).toBe('status');
      if (result.message?.type === 'status') {
        expect(result.message.status).toBe('error');
        expect(result.message.detail).toContain('KIMI_API_KEY');
      }
    });

    it('detects invalid_api_key errors', () => {
      const result = transport.handleStderr('invalid_api_key: check your credentials', emptyContext);
      expect(result.message).not.toBeNull();
      expect(result.message?.type).toBe('status');
    });

    it('returns null message for unknown stderr', () => {
      const result = transport.handleStderr('some debug output', emptyContext);
      expect(result.message).toBeNull();
    });
  });

  describe('getToolPatterns', () => {
    it('includes change_title and think patterns', () => {
      const patterns = transport.getToolPatterns();
      const names = patterns.map((p) => p.name);
      expect(names).toContain('change_title');
      expect(names).toContain('think');
    });
  });

  describe('extractToolNameFromId', () => {
    it('extracts change_title from toolCallId', () => {
      expect(transport.extractToolNameFromId('change_title-12345')).toBe('change_title');
      expect(transport.extractToolNameFromId('mcp__happy__change_title')).toBe('change_title');
    });

    it('extracts think from toolCallId', () => {
      expect(transport.extractToolNameFromId('think-67890')).toBe('think');
    });

    it('returns null for unknown toolCallId', () => {
      expect(transport.extractToolNameFromId('unknown-tool-123')).toBeNull();
    });
  });

  describe('determineToolName', () => {
    const emptyContext = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 };

    it('returns original name when not "other"', () => {
      expect(transport.determineToolName('read_file', 'read_file-123', {}, emptyContext)).toBe('read_file');
    });

    it('resolves "other" via toolCallId patterns', () => {
      expect(transport.determineToolName('other', 'change_title-123', {}, emptyContext)).toBe('change_title');
    });

    it('returns "other" when no pattern matches', () => {
      expect(transport.determineToolName('other', 'xyz-123', {}, emptyContext)).toBe('other');
    });
  });

  describe('getToolCallTimeout', () => {
    it('returns think timeout for think tools', () => {
      expect(transport.getToolCallTimeout('think-1', 'think')).toBe(KIMI_TIMEOUTS.think);
    });

    it('returns standard timeout for other tools', () => {
      expect(transport.getToolCallTimeout('read_file-1', 'read_file')).toBe(KIMI_TIMEOUTS.toolCall);
    });
  });

  describe('getIdleTimeout', () => {
    it('returns 500ms', () => {
      expect(transport.getIdleTimeout()).toBe(500);
    });
  });
});

/**
 * KimiTransport Tests
 *
 * Unit tests for the Kimi CLI transport handler.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { KimiTransport, KIMI_TIMEOUTS } from '../KimiTransport';
import type { StderrContext } from '../../TransportHandler';

describe('KimiTransport', () => {
  let transport: KimiTransport;

  beforeEach(() => {
    transport = new KimiTransport();
  });

  describe('getInitTimeout', () => {
    it('returns correct init timeout', () => {
      expect(transport.getInitTimeout()).toBe(KIMI_TIMEOUTS.init);
      expect(transport.getInitTimeout()).toBe(60000);
    });
  });

  describe('filterStdoutLine', () => {
    it('accepts valid JSON-RPC messages', () => {
      const validMessage = '{"jsonrpc": "2.0", "method": "initialize", "id": 1}';
      expect(transport.filterStdoutLine(validMessage)).toBe(validMessage);
    });

    it('accepts JSON-RPC arrays (batched)', () => {
      const batchedMessage = '[{"jsonrpc": "2.0", "method": "ping"}]';
      expect(transport.filterStdoutLine(batchedMessage)).toBe(batchedMessage);
    });

    it('rejects empty lines', () => {
      expect(transport.filterStdoutLine('')).toBeNull();
      expect(transport.filterStdoutLine('   ')).toBeNull();
    });

    it('rejects non-JSON lines', () => {
      expect(transport.filterStdoutLine('debug: some message')).toBeNull();
      expect(transport.filterStdoutLine('ERROR: something')).toBeNull();
    });

    it('rejects lines not starting with { or [', () => {
      expect(transport.filterStdoutLine('123')).toBeNull();
      expect(transport.filterStdoutLine('"string"')).toBeNull();
      expect(transport.filterStdoutLine('true')).toBeNull();
    });

    it('rejects JSON primitives', () => {
      expect(transport.filterStdoutLine('12345')).toBeNull();
      expect(transport.filterStdoutLine('"just a string"')).toBeNull();
      expect(transport.filterStdoutLine('null')).toBeNull();
    });

    it('handles whitespace correctly', () => {
      const message = '  {"jsonrpc": "2.0"}  ';
      expect(transport.filterStdoutLine(message)).toBe(message);
    });
  });

  describe('handleStderr', () => {
    const mockContext: StderrContext = {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    };

    it('returns null message for empty stderr', () => {
      const result = transport.handleStderr('', mockContext);
      expect(result.message).toBeNull();
      expect(result.suppress).toBe(true);
    });

    it('detects authentication failures', () => {
      const authErrors = [
        'Error: not logged in',
        'authentication required',
        '401 Unauthorized',
        'status 401',
      ];

      authErrors.forEach(error => {
        const result = transport.handleStderr(error, mockContext);
        expect(result.message).toEqual({
          type: 'status',
          status: 'error',
          detail: 'Not authenticated. Please run "kimi login" first.',
        });
      });
    });

    it('handles rate limit errors without showing to user', () => {
      const rateLimitErrors = [
        'status 429',
        'code":429',
        'rateLimitExceeded',
        'RATE_LIMIT',
        'too many requests',
      ];

      rateLimitErrors.forEach(error => {
        const result = transport.handleStderr(error, mockContext);
        expect(result.message).toBeNull();
        expect(result.suppress).toBe(false);
      });
    });

    it('detects model not found errors', () => {
      const result = transport.handleStderr('model not found: 404', mockContext);
      expect(result.message).toEqual({
        type: 'status',
        status: 'error',
        detail: 'Model not found or not available.',
      });
    });

    it('returns null for other stderr messages', () => {
      const result = transport.handleStderr('some debug info', mockContext);
      expect(result.message).toBeNull();
    });
  });

  describe('getToolPatterns', () => {
    it('returns tool patterns', () => {
      const patterns = transport.getToolPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.some(p => p.name === 'change_title')).toBe(true);
      expect(patterns.some(p => p.name === 'read_file')).toBe(true);
      expect(patterns.some(p => p.name === 'write_file')).toBe(true);
    });
  });

  describe('extractToolNameFromId', () => {
    it('extracts tool name from ID with known patterns', () => {
      expect(transport.extractToolNameFromId('change_title-123')).toBe('change_title');
      expect(transport.extractToolNameFromId('read_file-abc')).toBe('read_file');
      expect(transport.extractToolNameFromId('write_file_123')).toBe('write_file');
      expect(transport.extractToolNameFromId('search_files-pattern')).toBe('search_files');
    });

    it('handles case-insensitive matching', () => {
      expect(transport.extractToolNameFromId('CHANGE_TITLE-123')).toBe('change_title');
      expect(transport.extractToolNameFromId('Read_File-abc')).toBe('read_file');
    });

    it('returns null for unknown tool IDs', () => {
      expect(transport.extractToolNameFromId('unknown_tool-123')).toBeNull();
      expect(transport.extractToolNameFromId('random-id')).toBeNull();
    });
  });

  describe('isLongRunningTool', () => {
    it('identifies search tools as long-running', () => {
      expect(transport.isLongRunningTool('search_files-123')).toBe(true);
      expect(transport.isLongRunningTool('grep-pattern')).toBe(true);
      expect(transport.isLongRunningTool('find_files-abc')).toBe(true);
    });

    it('identifies non-search tools as normal', () => {
      expect(transport.isLongRunningTool('read_file-123')).toBe(false);
      expect(transport.isLongRunningTool('write_file-abc')).toBe(false);
      expect(transport.isLongRunningTool('change_title-xyz')).toBe(false);
    });

    it('checks toolKind parameter', () => {
      expect(transport.isLongRunningTool('any-id', 'search')).toBe(true);
      expect(transport.isLongRunningTool('any-id', 'grep')).toBe(true);
      expect(transport.isLongRunningTool('any-id', 'read')).toBe(false);
    });
  });

  describe('getToolCallTimeout', () => {
    it('returns long timeout for investigation tools', () => {
      expect(transport.getToolCallTimeout('search_files-123')).toBe(KIMI_TIMEOUTS.longRunning);
    });

    it('returns standard timeout for regular tools', () => {
      expect(transport.getToolCallTimeout('read_file-123')).toBe(KIMI_TIMEOUTS.toolCall);
      expect(transport.getToolCallTimeout('write_file-abc')).toBe(KIMI_TIMEOUTS.toolCall);
    });
  });

  describe('determineToolName', () => {
    it('returns original name if not "other" or "Unknown tool"', () => {
      expect(transport.determineToolName('read_file', 'id', {}, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('read_file');
      expect(transport.determineToolName('write_file', 'id', {}, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('write_file');
    });

    it('extracts name from toolCallId when tool name is "other"', () => {
      expect(transport.determineToolName('other', 'change_title-123', {}, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('change_title');
      expect(transport.determineToolName('other', 'read_file-abc', {}, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('read_file');
    });

    it('detects tool from input fields', () => {
      expect(transport.determineToolName('other', 'unknown-id', { title: 'New Title' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('change_title');
      expect(transport.determineToolName('other', 'unknown-id', { file_path: '/path' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('read_file');
    });

    it('uses default for empty input with "other"', () => {
      // change_title is the default for empty input
      expect(transport.determineToolName('other', 'some-id', {}, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('change_title');
    });

    it('returns original for unknown patterns', () => {
      expect(transport.determineToolName('other', 'unknown-id', { unknown_field: true }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })).toBe('other');
    });
  });

  describe('getIdleTimeout', () => {
    it('returns correct idle timeout', () => {
      expect(transport.getIdleTimeout()).toBe(KIMI_TIMEOUTS.idle);
      expect(transport.getIdleTimeout()).toBe(500);
    });
  });
});

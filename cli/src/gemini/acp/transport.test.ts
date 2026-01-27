import { describe, expect, it } from 'vitest';

import { geminiTransport } from './transport';

describe('GeminiTransport determineToolName', () => {
  it('detects write_file tool calls', () => {
    expect(
      geminiTransport.determineToolName('other', 'write_file-123', { filePath: '/tmp/a', content: 'x' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })
    ).toBe('write');
  });

  it('detects run_shell_command tool calls', () => {
    expect(
      geminiTransport.determineToolName('other', 'run_shell_command-123', { command: 'pwd' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })
    ).toBe('execute');
  });

  it('detects read_file tool calls', () => {
    expect(
      geminiTransport.determineToolName('other', 'read_file-123', { filePath: '/tmp/a' }, { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 })
    ).toBe('read');
  });
});

describe('GeminiTransport extractToolNameFromId', () => {
  it('prefers TodoWrite over write for write_todos toolCallIds', () => {
    expect(geminiTransport.extractToolNameFromId('write_todos-123')).toBe('TodoWrite');
  });

  it('detects replace as edit', () => {
    expect(geminiTransport.extractToolNameFromId('replace-123')).toBe('edit');
  });

  it('detects glob toolCallIds', () => {
    expect(geminiTransport.extractToolNameFromId('glob-123')).toBe('glob');
  });
});

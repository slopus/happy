import { describe, expect, it } from 'vitest';

import { OpenCodeTransport } from './transport';

const ctx = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 } as const;

describe('OpenCodeTransport determineToolName', () => {
  it('returns the original tool name when it is not "other"', () => {
    const transport = new OpenCodeTransport();
    expect(transport.determineToolName('read', 'read-1', { path: '/tmp/x' }, ctx)).toBe('read');
  });

  it('extracts a tool name from toolCallId patterns (case-insensitive)', () => {
    const transport = new OpenCodeTransport();
    expect(transport.determineToolName('other', 'BASH-123', { command: 'ls' }, ctx)).toBe('bash');
    expect(transport.determineToolName('other', 'mcp__happy__change_title-1', {}, ctx)).toBe('change_title');
  });

  it('infers a tool name from input field signatures when toolCallId is not helpful', () => {
    const transport = new OpenCodeTransport();
    expect(transport.determineToolName('other', 'unknown-1', { filePath: '/tmp/x' }, ctx)).toBe('read');
    expect(transport.determineToolName('other', 'unknown-2', { oldString: 'a', newString: 'b' }, ctx)).toBe('edit');
  });

  it('does not guess a tool name for empty input without an id match', () => {
    const transport = new OpenCodeTransport();
    expect(transport.determineToolName('other', 'unknown-3', {}, ctx)).toBe('other');
  });
});

describe('OpenCodeTransport handleStderr', () => {
  it('suppresses empty stderr lines', () => {
    const transport = new OpenCodeTransport();
    expect(transport.handleStderr('   ', { activeToolCalls: new Set(), hasActiveInvestigation: false })).toEqual({
      message: null,
      suppress: true,
    });
  });

  it('emits actionable auth errors', () => {
    const transport = new OpenCodeTransport();
    const res = transport.handleStderr('Unauthorized: missing API key', { activeToolCalls: new Set(), hasActiveInvestigation: false });
    expect(res.message?.type).toBe('status');
    expect((res.message as any)?.status).toBe('error');
  });

  it('emits actionable model-not-found errors', () => {
    const transport = new OpenCodeTransport();
    const res = transport.handleStderr('Model not found', { activeToolCalls: new Set(), hasActiveInvestigation: false });
    expect(res.message?.type).toBe('status');
    expect((res.message as any)?.status).toBe('error');
  });
});

describe('OpenCodeTransport timeouts', () => {
  it('treats task-like tool calls as investigation tools', () => {
    const transport = new OpenCodeTransport();
    expect(transport.isInvestigationTool('task-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool('explore-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'task')).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'read')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { normalizeAcpToolArgs } from './toolNormalization';

describe('normalizeAcpToolArgs', () => {
  it('normalizes shell command aliases into command', () => {
    expect(
      normalizeAcpToolArgs({
        toolKind: 'exec',
        toolName: 'other',
        rawInput: null,
        args: { cmd: ' ls -la ' },
      }).command
    ).toBe('ls -la');
  });

  it('normalizes file path aliases into file_path', () => {
    expect(
      normalizeAcpToolArgs({
        toolKind: 'read',
        toolName: 'read',
        rawInput: null,
        args: { filePath: '/tmp/a.txt' },
      }).file_path
    ).toBe('/tmp/a.txt');
  });

  it('normalizes edit oldString/newString into oldText/newText', () => {
    const normalized = normalizeAcpToolArgs({
      toolKind: 'edit',
      toolName: 'edit',
      rawInput: null,
      args: { oldString: 'a', newString: 'b', filePath: '/tmp/x' },
    });

    expect(normalized.oldText).toBe('a');
    expect(normalized.newText).toBe('b');
    expect(normalized.path).toBe('/tmp/x');
  });

  it('normalizes ACP diff items[] into file_path and content for write', () => {
    const normalized = normalizeAcpToolArgs({
      toolKind: 'write',
      toolName: 'write',
      rawInput: null,
      args: {
        items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
      },
    });

    expect(normalized.file_path).toBe('/tmp/a.txt');
    expect(normalized.content).toBe('new');
  });

  it('normalizes ACP diff items[] into file_path and oldText/newText for edit', () => {
    const normalized = normalizeAcpToolArgs({
      toolKind: 'edit',
      toolName: 'edit',
      rawInput: null,
      args: {
        items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
      },
    });

    expect(normalized.file_path).toBe('/tmp/a.txt');
    expect(normalized.oldText).toBe('old');
    expect(normalized.newText).toBe('new');
  });
});

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
});


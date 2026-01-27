import { describe, expect, it } from 'vitest';
import { formatErrorForUi } from './formatErrorForUi';

describe('formatErrorForUi', () => {
  it('formats Error instances using stack when available', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    expect(formatErrorForUi(err)).toContain('STACK');
  });

  it('formats non-Error values as strings', () => {
    expect(formatErrorForUi('nope')).toBe('nope');
    expect(formatErrorForUi(123)).toBe('123');
  });

  it('truncates long output with a suffix', () => {
    const input = 'x'.repeat(1201);
    const out = formatErrorForUi(input, { maxChars: 1000 });
    expect(out).toContain('…[truncated]');
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
  });
});


import { describe, expect, it } from 'vitest';
import { formatGeminiErrorForUi } from './formatGeminiErrorForUi';

describe('formatGeminiErrorForUi', () => {
  it('formats Error instances using stack when available', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    expect(formatGeminiErrorForUi(err, null)).toContain('STACK');
  });

  it('formats model-not-found errors', () => {
    expect(formatGeminiErrorForUi({ code: 404 }, 'gemini-x')).toContain('Model "gemini-x" not found');
  });

  it('formats empty object errors as missing CLI install', () => {
    expect(formatGeminiErrorForUi({}, null)).toContain('Is "gemini" CLI installed?');
  });

  it('does not include empty quota reset time when no duration is captured', () => {
    expect(formatGeminiErrorForUi({ message: 'quota reset after ' }, null)).not.toContain('Quota resets in .');
  });
});

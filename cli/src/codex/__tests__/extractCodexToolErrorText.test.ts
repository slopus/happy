import { describe, expect, it } from 'vitest';
import { extractCodexToolErrorText } from '../runCodex';
import type { CodexToolResponse } from '../types';

describe('extractCodexToolErrorText', () => {
  it('returns null when response is not an error', () => {
    const response: CodexToolResponse = {
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    };

    expect(extractCodexToolErrorText(response)).toBeNull();
  });

  it('returns concatenated text when response is an error', () => {
    const response: CodexToolResponse = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      isError: true,
    };

    expect(extractCodexToolErrorText(response)).toBe('first\nsecond');
  });

  it('returns a fallback message when response is an error but has no text', () => {
    const response: CodexToolResponse = {
      content: [{ type: 'image' }],
      isError: true,
    };

    expect(extractCodexToolErrorText(response)).toBe('Codex error');
  });
});


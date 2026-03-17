import { describe, expect, it } from 'vitest';
import { normalizeGeminiOutputText } from './orchestratorOutput';

describe('normalizeGeminiOutputText', () => {
  it('keeps plain text output unchanged when stdout is not JSON', () => {
    const stdout = 'Hello from Gemini\nHow can I help?\n';
    expect(normalizeGeminiOutputText(stdout)).toBe('Hello from Gemini\nHow can I help?');
  });

  it('extracts natural language text from single JSON output', () => {
    const stdout = JSON.stringify({
      session_id: '11111111-2222-4333-8444-555555555555',
      response: {
        parts: [{ text: '这是纯文本回答' }],
      },
    });
    expect(normalizeGeminiOutputText(stdout)).toBe('这是纯文本回答');
  });

  it('extracts natural language text from line-delimited JSON output', () => {
    const stdout = [
      JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555' }),
      JSON.stringify({ output: { text: '第一段' } }),
      JSON.stringify({ output: { text: '第二段' } }),
    ].join('\n');

    expect(normalizeGeminiOutputText(stdout)).toBe('第一段\n第二段');
  });
});

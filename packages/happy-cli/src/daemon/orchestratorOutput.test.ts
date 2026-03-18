import { describe, expect, it } from 'vitest';
import { extractCodexSessionId, extractGeminiSessionId, extractGeminiSessionIdFromJsonLine, normalizeGeminiOutputText } from './orchestratorOutput';

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

describe('extractCodexSessionId', () => {
  it('extracts session id from codex output header', () => {
    const output = 'session id: 019cfcd3-1c88-79f2-81f2-cbad04e7a7a8\n';
    expect(extractCodexSessionId(output)).toBe('019cfcd3-1c88-79f2-81f2-cbad04e7a7a8');
  });

  it('extracts session id when output contains ANSI color escapes', () => {
    const output = 'session id: \u001b[32m019cfcd3-1c88-79f2-81f2-cbad04e7a7a8\u001b[0m\n';
    expect(extractCodexSessionId(output)).toBe('019cfcd3-1c88-79f2-81f2-cbad04e7a7a8');
  });
});

describe('extractGeminiSessionIdFromJsonLine', () => {
  it('extracts session_id from gemini json line', () => {
    const line = JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555' });
    expect(extractGeminiSessionIdFromJsonLine(line)).toBe('11111111-2222-4333-8444-555555555555');
  });
});

describe('extractGeminiSessionId', () => {
  it('extracts session_id from pretty-printed JSON output', () => {
    const stdout = JSON.stringify({
      session_id: '11111111-2222-4333-8444-555555555555',
      response: 'hello',
    }, null, 2);
    expect(extractGeminiSessionId(stdout)).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('extracts session_id from single-line JSON output', () => {
    const stdout = JSON.stringify({ session_id: '22222222-3333-4444-8555-666666666666' });
    expect(extractGeminiSessionId(stdout)).toBe('22222222-3333-4444-8555-666666666666');
  });

  it('extracts session_id from line-delimited JSON output', () => {
    const stdout = [
      JSON.stringify({ session_id: '33333333-4444-5555-8666-777777777777' }),
      JSON.stringify({ output: { text: 'hello' } }),
    ].join('\n');
    expect(extractGeminiSessionId(stdout)).toBe('33333333-4444-5555-8666-777777777777');
  });

  it('returns null for output without session_id', () => {
    expect(extractGeminiSessionId('plain text output')).toBeNull();
    expect(extractGeminiSessionId(JSON.stringify({ response: 'hello' }))).toBeNull();
    expect(extractGeminiSessionId('')).toBeNull();
  });
});

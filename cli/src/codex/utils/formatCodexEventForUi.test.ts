import { describe, expect, it } from 'vitest';
import { formatCodexEventForUi } from './formatCodexEventForUi';

describe('formatCodexEventForUi', () => {
  it('formats generic error events', () => {
    expect(formatCodexEventForUi({ type: 'error', message: 'bad' })).toBe('Codex error: bad');
  });

  it('formats stream errors', () => {
    expect(formatCodexEventForUi({ type: 'stream_error', message: 'oops' })).toBe('Codex stream error: oops');
  });

  it('formats MCP startup failures', () => {
    expect(
      formatCodexEventForUi({
        type: 'mcp_startup_update',
        server: 'happy',
        status: { state: 'failed', error: 'nope' },
      }),
    ).toBe('MCP server "happy" failed to start: nope');
  });

  it('avoids redundant fallback text for MCP startup failures without an error string', () => {
    expect(
      formatCodexEventForUi({
        type: 'mcp_startup_update',
        status: { state: 'failed' },
      }),
    ).toBe('MCP server "unknown" failed to start: unknown error');
  });

  it('returns null for events that should not be shown', () => {
    expect(formatCodexEventForUi({ type: 'agent_message', message: 'hi' })).toBeNull();
  });
});

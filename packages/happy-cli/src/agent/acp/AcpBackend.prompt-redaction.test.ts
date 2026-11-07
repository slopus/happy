import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { AcpBackend } from './AcpBackend';

function createBackend(): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: '/tmp',
    command: '/bin/true',
  });
}

function stubConnection(backend: AcpBackend): void {
  // `sendPrompt` short-circuits when these aren't set; stub them so the
  // happy-path log calls fire without spawning a real ACP agent.
  (backend as unknown as { acpSessionId: string }).acpSessionId = 'test-session';
  (backend as unknown as { connection: { prompt: (...args: unknown[]) => Promise<unknown> } }).connection = {
    prompt: vi.fn(async () => ({})),
  };
}

function joinDebugMessages(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((call) =>
      call
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' '),
    )
    .join('\n');
}

describe('AcpBackend.sendPrompt — prompt log redaction', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {
      // Suppress noise in test output.
    });
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('never logs the prompt body verbatim', async () => {
    const backend = createBackend();
    stubConnection(backend);
    const secret = 'API_KEY=sk-leak-via-debug-log';

    await backend.sendPrompt('test-session', secret);

    const allDebugMessages = joinDebugMessages(debugSpy);
    expect(allDebugMessages).not.toContain(secret);
  });

  it('logs the prompt length so debugging context is still available', async () => {
    const backend = createBackend();
    stubConnection(backend);
    const prompt = 'hello world'; // length 11

    await backend.sendPrompt('test-session', prompt);

    const allDebugMessages = joinDebugMessages(debugSpy);
    expect(allDebugMessages).toContain('length: 11');
  });

  it('logs the sessionId and block count without dumping the request body', async () => {
    const backend = createBackend();
    stubConnection(backend);

    await backend.sendPrompt('test-session', 'whatever');

    const allDebugMessages = joinDebugMessages(debugSpy);
    expect(allDebugMessages).toContain('sessionId=test-session');
    expect(allDebugMessages).toContain('blocks=1');
    // The pre-redaction code path dumped `JSON.stringify(promptRequest, null, 2)`
    // which embedded the prompt text inside a `text` field — guard against
    // accidentally reintroducing that.
    expect(allDebugMessages).not.toMatch(/"text":\s*"whatever"/);
  });
});

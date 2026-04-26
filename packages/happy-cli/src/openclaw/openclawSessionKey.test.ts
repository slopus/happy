import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildHappySessionKey, resolveOpenClawSessionKey, OpenClawBackend } from './OpenClawBackend';
import type { OpenClawGatewayConfig } from './openclawTypes';

describe('buildHappySessionKey', () => {
  it('builds an isolated per-Happy-session key from the gateway main key', () => {
    expect(buildHappySessionKey('agent:main:main', 'abc-123')).toBe('agent:main:happy:abc-123');
  });

  it('preserves a non-default agentId', () => {
    expect(buildHappySessionKey('agent:research:main', 'tag-xyz')).toBe('agent:research:happy:tag-xyz');
  });

  it('falls back to mainKey when the format is unexpected', () => {
    expect(buildHappySessionKey('main', 'tag')).toBe('main');
    expect(buildHappySessionKey('agent::main', 'tag')).toBe('agent::main');
    expect(buildHappySessionKey('not-an-agent-key', 'tag')).toBe('not-an-agent-key');
  });
});

describe('resolveOpenClawSessionKey', () => {
  const ORIGINAL_ENV = process.env.HAPPY_OPENCLAW_SESSION_KEY;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.HAPPY_OPENCLAW_SESSION_KEY;
    else process.env.HAPPY_OPENCLAW_SESSION_KEY = ORIGINAL_ENV;
  });

  it('returns the env override verbatim when set', () => {
    expect(
      resolveOpenClawSessionKey({
        mainKey: 'agent:main:main',
        sessionTag: 'tag-1',
        envOverride: 'agent:main:custom-key',
      }),
    ).toBe('agent:main:custom-key');
  });

  it('isolates per Happy session by default', () => {
    expect(
      resolveOpenClawSessionKey({ mainKey: 'agent:main:main', sessionTag: 'tag-1' }),
    ).toBe('agent:main:happy:tag-1');
  });

  it('falls back to mainKey when no sessionTag and no env override (legacy behavior)', () => {
    expect(
      resolveOpenClawSessionKey({ mainKey: 'agent:main:main' }),
    ).toBe('agent:main:main');
  });

  it('treats blank env override as unset', () => {
    expect(
      resolveOpenClawSessionKey({
        mainKey: 'agent:main:main',
        sessionTag: 'tag-1',
        envOverride: '   ',
      }),
    ).toBe('agent:main:happy:tag-1');
  });

  it('produces unique keys across distinct Happy sessions', () => {
    const a = resolveOpenClawSessionKey({ mainKey: 'agent:main:main', sessionTag: 'tag-A' });
    const b = resolveOpenClawSessionKey({ mainKey: 'agent:main:main', sessionTag: 'tag-B' });
    expect(a).not.toBe(b);
  });
});

describe('OpenClawBackend chat-event sessionKey filter', () => {
  const gatewayConfig: OpenClawGatewayConfig = { url: 'ws://127.0.0.1:1' };
  const baseOpts = { homeDir: '/tmp', gatewayConfig, sessionTag: 'tag-A' };

  const makeBackendWithKey = (sessionKey: string) => {
    const backend = new OpenClawBackend(baseOpts);
    // The filter compares against `this.sessionKey`, normally set by startSession()
    // after the gateway hello. Inject it here so we can unit-test handleEvent in isolation.
    (backend as unknown as { sessionKey: string | null }).sessionKey = sessionKey;
    return backend;
  };

  it('drops chat events whose sessionKey does not match this backend', () => {
    const backend = makeBackendWithKey('agent:main:happy:tag-A');
    const handler = vi.fn();
    backend.onMessage(handler);

    // Simulate a delta event for a DIFFERENT session (case-insensitive normalization on gateway side)
    (backend as unknown as { handleEvent: (e: string, p: unknown) => void }).handleEvent('chat', {
      runId: 'r1', sessionKey: 'agent:main:happy:tag-B', seq: 0, state: 'delta',
      message: { content: [{ type: 'text', text: 'leaked' }] },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards chat events whose sessionKey matches', () => {
    const backend = makeBackendWithKey('agent:main:happy:tag-A');
    const handler = vi.fn();
    backend.onMessage(handler);

    (backend as unknown as { handleEvent: (e: string, p: unknown) => void }).handleEvent('chat', {
      runId: 'r1', sessionKey: 'agent:main:happy:tag-A', seq: 0, state: 'delta',
      message: { content: [{ type: 'text', text: 'mine' }] },
    });
    expect(handler).toHaveBeenCalled();
  });

  it('compares case-insensitively (gateway lowercases keys)', () => {
    const backend = makeBackendWithKey('agent:main:happy:Tag-A');
    const handler = vi.fn();
    backend.onMessage(handler);

    (backend as unknown as { handleEvent: (e: string, p: unknown) => void }).handleEvent('chat', {
      runId: 'r1', sessionKey: 'agent:main:happy:tag-a', seq: 0, state: 'delta',
      message: { content: [{ type: 'text', text: 'mine' }] },
    });
    expect(handler).toHaveBeenCalled();
  });
});

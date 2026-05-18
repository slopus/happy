import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  redactArgvForLog,
  redactObjectForLog,
} from './redactSecrets';

describe('redactArgvForLog', () => {
  it('redacts the value of a KEY=VAL arg when KEY contains a secret-name substring', () => {
    expect(redactArgvForLog(['happy', '--claude-env', 'ANTHROPIC_TOKEN=sk-leak-12345'])).toEqual([
      'happy',
      '--claude-env',
      `ANTHROPIC_TOKEN=${REDACTED}`,
    ]);
  });

  it('redacts case-insensitively (lower, mixed)', () => {
    expect(redactArgvForLog(['accessToken=value-1', 'API_KEY=value-2', 'oauth_secret=value-3'])).toEqual([
      `accessToken=${REDACTED}`,
      `API_KEY=${REDACTED}`,
      `oauth_secret=${REDACTED}`,
    ]);
  });

  it('passes through args without `=`', () => {
    expect(redactArgvForLog(['happy', '--yolo', 'codex'])).toEqual(['happy', '--yolo', 'codex']);
  });

  it('passes through KEY=VAL when KEY is not secret-named', () => {
    expect(redactArgvForLog(['LOG_LEVEL=debug', 'NODE_ENV=production'])).toEqual([
      'LOG_LEVEL=debug',
      'NODE_ENV=production',
    ]);
  });

  it('does not crash on empty or odd inputs', () => {
    expect(redactArgvForLog([])).toEqual([]);
    expect(redactArgvForLog(['='])).toEqual(['=']); // key empty → eqIdx <= 0
    expect(redactArgvForLog(['TOKEN='])).toEqual([`TOKEN=${REDACTED}`]); // empty value still redacted
  });

  it('does not double-redact a value that already contains `=`', () => {
    // The first `=` is the boundary; the rest is the value (redacted whole).
    expect(redactArgvForLog(['SECRET_KEY=val=with=equals'])).toEqual([`SECRET_KEY=${REDACTED}`]);
  });
});

describe('redactObjectForLog', () => {
  it('redacts top-level token / encryptionKey / password / auth keys', () => {
    expect(
      redactObjectForLog({
        sessionId: 'sid-1',
        token: 'oauth-secret',
        encryptionKey: 'base64-key',
        password: 'p',
        unrelated: 42,
      }),
    ).toEqual({
      sessionId: 'sid-1',
      token: REDACTED,
      encryptionKey: REDACTED,
      password: REDACTED,
      unrelated: 42,
    });
  });

  it('force-redacts environmentVariables wholesale (free-form user values)', () => {
    expect(
      redactObjectForLog({
        environmentVariables: { ANYTHING: 'could be a secret' },
      }),
    ).toEqual({ environmentVariables: REDACTED });
  });

  it('redacts inside nested objects and arrays', () => {
    expect(
      redactObjectForLog({
        config: { apiKey: 'leak', name: 'ok' },
        history: [{ accessToken: 'also leak' }, { kind: 'log' }],
      }),
    ).toEqual({
      config: { apiKey: REDACTED, name: 'ok' },
      history: [{ accessToken: REDACTED }, { kind: 'log' }],
    });
  });

  it('leaves primitives / null / undefined untouched', () => {
    expect(redactObjectForLog(null)).toBeNull();
    expect(redactObjectForLog(undefined)).toBeUndefined();
    expect(redactObjectForLog(42)).toBe(42);
    expect(redactObjectForLog('hello')).toBe('hello');
    expect(redactObjectForLog(true)).toBe(true);
  });

  it('preserves Date / RegExp / typed-array values without descending into them', () => {
    const now = new Date();
    const re = /foo/i;
    const buf = new Uint8Array([1, 2, 3]);
    expect(redactObjectForLog(now)).toBe(now);
    expect(redactObjectForLog(re)).toBe(re);
    expect(redactObjectForLog(buf)).toBe(buf);
  });
});

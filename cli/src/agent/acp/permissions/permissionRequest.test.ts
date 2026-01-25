import { describe, expect, it } from 'vitest';

import { extractPermissionInputWithFallback } from './permissionRequest';

describe('extractPermissionInputWithFallback', () => {
  it('uses params input when present', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { rawInput: { filePath: '/tmp/a' } } },
        'call_1',
        new Map([['call_1', { filePath: '/tmp/fallback' }]])
      )
    ).toEqual({ filePath: '/tmp/a' });
  });

  it('uses toolCallId fallback when params input is empty', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { kind: 'other' } },
        'call_2',
        new Map([['call_2', { filePath: '/tmp/fallback' }]])
      )
    ).toEqual({ filePath: '/tmp/fallback' });
  });

  it('returns empty object when nothing is available', () => {
    expect(extractPermissionInputWithFallback({}, 'call_3', new Map())).toEqual({});
  });
});


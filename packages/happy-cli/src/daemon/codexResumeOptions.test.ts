import { describe, expect, it } from 'vitest';

import { normalizeCodexResumeOptions } from './codexResumeOptions';

describe('normalizeCodexResumeOptions', () => {
  it('omits app default model sentinel so Codex uses its configured default', () => {
    expect(normalizeCodexResumeOptions({ model: 'default' })).toEqual({});
  });

  it('preserves explicit model selections', () => {
    expect(normalizeCodexResumeOptions({ model: 'gpt-5.5' })).toEqual({
      model: 'gpt-5.5',
    });
  });

  it('omits app default and Claude-specific permission sentinels', () => {
    expect(normalizeCodexResumeOptions({ permissionMode: 'default' })).toEqual({});
    expect(normalizeCodexResumeOptions({ permissionMode: 'bypassPermissions' })).toEqual({});
  });

  it('preserves Codex-native non-default permission modes', () => {
    expect(normalizeCodexResumeOptions({ permissionMode: 'read-only' })).toEqual({
      permissionMode: 'read-only',
    });
    expect(normalizeCodexResumeOptions({ permissionMode: 'safe-yolo' })).toEqual({
      permissionMode: 'safe-yolo',
    });
    expect(normalizeCodexResumeOptions({ permissionMode: 'yolo' })).toEqual({
      permissionMode: 'yolo',
    });
  });
});

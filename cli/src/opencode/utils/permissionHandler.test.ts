import { describe, expect, it } from 'vitest';

import { isOpenCodeWriteLikeToolName } from './permissionHandler';

describe('isOpenCodeWriteLikeToolName', () => {
  it('treats unknown tool names as write-like for safety', () => {
    expect(isOpenCodeWriteLikeToolName('other')).toBe(true);
    expect(isOpenCodeWriteLikeToolName('Unknown tool')).toBe(true);
    expect(isOpenCodeWriteLikeToolName('unknown')).toBe(true);
  });

  it('treats common write tools as write-like', () => {
    expect(isOpenCodeWriteLikeToolName('write')).toBe(true);
    expect(isOpenCodeWriteLikeToolName('edit_file')).toBe(true);
    expect(isOpenCodeWriteLikeToolName('bash')).toBe(true);
  });

  it('treats common read tools as not write-like', () => {
    expect(isOpenCodeWriteLikeToolName('read')).toBe(false);
    expect(isOpenCodeWriteLikeToolName('glob')).toBe(false);
    expect(isOpenCodeWriteLikeToolName('grep')).toBe(false);
  });
});


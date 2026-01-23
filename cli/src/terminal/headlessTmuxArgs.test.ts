import { describe, expect, it } from 'vitest';

import { ensureRemoteStartingModeArgs } from './headlessTmuxArgs';

describe('ensureRemoteStartingModeArgs', () => {
  it('appends remote mode when not present', () => {
    expect(ensureRemoteStartingModeArgs(['--foo'])).toEqual([
      '--foo',
      '--happy-starting-mode',
      'remote',
    ]);
  });

  it('keeps explicit remote mode', () => {
    expect(ensureRemoteStartingModeArgs(['--happy-starting-mode', 'remote'])).toEqual([
      '--happy-starting-mode',
      'remote',
    ]);
  });

  it('throws when local mode is requested', () => {
    expect(() => ensureRemoteStartingModeArgs(['--happy-starting-mode', 'local'])).toThrow(
      'Headless tmux sessions require remote mode',
    );
  });

  it('throws a helpful error when --happy-starting-mode is missing a value', () => {
    expect(() => ensureRemoteStartingModeArgs(['--happy-starting-mode'])).toThrow(/--happy-starting-mode/);
  });
});

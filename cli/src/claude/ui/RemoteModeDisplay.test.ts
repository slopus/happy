import { describe, expect, it } from 'vitest';

import { interpretRemoteModeKeypress } from './RemoteModeDisplay';

describe('RemoteModeDisplay input handling', () => {
  it('switches immediately on Ctrl+T', () => {
    const result = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, 't', { ctrl: true });
    expect(result.action).toBe('switch');
  });

  it('requires double space to switch when using spacebar', () => {
    const first = interpretRemoteModeKeypress({ confirmationMode: null, actionInProgress: null }, ' ', {});
    expect(first.action).toBe('confirm-switch');

    const second = interpretRemoteModeKeypress({ confirmationMode: 'switch', actionInProgress: null }, ' ', {});
    expect(second.action).toBe('switch');
  });
});


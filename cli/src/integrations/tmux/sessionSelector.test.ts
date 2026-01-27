import { describe, expect, it } from 'vitest';

import { selectPreferredTmuxSessionName } from './sessionSelector';

describe('selectPreferredTmuxSessionName', () => {
  it('prefers attached sessions over detached', () => {
    const stdout = ['dev\t1\t100', 'other\t0\t200'].join('\n');
    expect(selectPreferredTmuxSessionName(stdout)).toBe('dev');
  });

  it('prefers most recently attached among attached sessions', () => {
    const stdout = ['a\t1\t100', 'b\t1\t200', 'c\t0\t999'].join('\n');
    expect(selectPreferredTmuxSessionName(stdout)).toBe('b');
  });

  it('returns null when no valid sessions exist', () => {
    expect(selectPreferredTmuxSessionName('')).toBeNull();
    expect(selectPreferredTmuxSessionName('\n\n')).toBeNull();
    expect(selectPreferredTmuxSessionName('bad-line')).toBeNull();
  });
});

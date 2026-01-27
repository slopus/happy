import { describe, expect, it } from 'vitest';

import { AGENTS } from './catalog';

describe('headless tmux argv transforms', () => {
  it('forces remote starting mode for claude', async () => {
    const transform = await AGENTS.claude.getHeadlessTmuxArgvTransform!();
    expect(transform(['--foo'])).toEqual(['--foo', '--happy-starting-mode', 'remote']);
  });

  it('does not rewrite argv for codex', async () => {
    expect(AGENTS.codex.getHeadlessTmuxArgvTransform).toBeUndefined();
  });
});


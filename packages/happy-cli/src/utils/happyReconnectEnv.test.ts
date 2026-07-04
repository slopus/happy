import { describe, expect, it } from 'vitest';

import { createHappyChildEnv, createHappyTmuxChildEnv, HAPPY_RECONNECT_ENV_KEYS } from './happyReconnectEnv';

describe('createHappyChildEnv', () => {
  it('removes stale Happy reconnect variables while preserving ordinary env vars', () => {
    expect(createHappyChildEnv({
      PATH: '/usr/bin',
      HAPPY_HOME_DIR: '/tmp/happy',
      HAPPY_RECONNECT_SESSION_ID: 'old-session',
      HAPPY_RECONNECT_ENCRYPTION_KEY: 'old-key',
      HAPPY_RECONNECT_FUTURE_FIELD: 'old-value',
      UNDEFINED_VALUE: undefined,
    })).toEqual({
      PATH: '/usr/bin',
      HAPPY_HOME_DIR: '/tmp/happy',
    });
  });

  it('neutralizes known reconnect variables for tmux windows', () => {
    const env = createHappyTmuxChildEnv({
      PATH: '/usr/bin',
      HAPPY_RECONNECT_SESSION_ID: 'old-session',
      HAPPY_RECONNECT_ENCRYPTION_KEY: 'old-key',
      HAPPY_RECONNECT_FUTURE_FIELD: 'old-value',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('HAPPY_RECONNECT_FUTURE_FIELD');
    for (const key of HAPPY_RECONNECT_ENV_KEYS) {
      expect(env[key]).toBe('');
    }
  });
});

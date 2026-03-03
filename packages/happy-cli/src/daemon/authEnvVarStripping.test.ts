/**
 * Tests for auth environment variable stripping in daemon session spawning
 * 
 * Issue #120: When daemon spawns sessions, it must strip inherited auth environment
 * variables (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN)
 * unless explicitly set by the selected profile. This prevents unexpectedly using
 * API key auth instead of Claude Max's native OAuth.
 */

import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Helper to build a clean environment with auth var stripping
 * This mimics the logic that should be in daemon/run.ts for stripping auth vars
 */
function buildCleanEnvironment(
  inheritedEnv: Record<string, string | undefined>,
  profileEnv: Record<string, string>
): Record<string, string> {
  const authVarsToStrip = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const baseEnv: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined) {
      // Strip auth vars from inherited env unless the profile explicitly sets them
      if (authVarsToStrip.includes(key) && !(key in profileEnv)) {
        continue;
      }
      baseEnv[key] = value;
    }
  }
  
  return baseEnv;
}

describe('Auth Environment Variable Stripping (Issue #120)', () => {
  let inheritedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Setup: daemon inherits typical shell environment with various vars
    inheritedEnv = {
      'PATH': '/usr/local/bin:/usr/bin',
      'HOME': '/home/user',
      'USER': 'testuser',
      'ANTHROPIC_API_KEY': 'sk-test-key-12345',  // Stale API key in daemon's shell
      'ANTHROPIC_AUTH_TOKEN': 'legacy-token',     // Should be stripped
      'CLAUDE_CODE_OAUTH_TOKEN': 'oauth-token',   // Should be stripped
      'CUSTOM_VAR': 'custom-value',
      'NODE_ENV': 'production'
    };
  });

  it('should strip inherited auth vars when profile does not set them', () => {
    const profileEnv = {}; // Profile sets no auth vars

    const result = buildCleanEnvironment(inheritedEnv, profileEnv);

    // Auth vars should be stripped
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    // Other vars should pass through
    expect(result.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.USER).toBe('testuser');
    expect(result.CUSTOM_VAR).toBe('custom-value');
    expect(result.NODE_ENV).toBe('production');
  });

  it('should preserve auth vars when profile explicitly sets them', () => {
    // Profile explicitly sets ANTHROPIC_API_KEY (e.g., for a different account/org)
    const profileEnv = {
      'ANTHROPIC_API_KEY': 'sk-profile-key-98765'
    };

    const result = buildCleanEnvironment(inheritedEnv, profileEnv);

    // Auth var should be preserved since profile set it
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test-key-12345');

    // Other auth vars still stripped (profile didn't set them)
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('should allow profile to override all three auth vars', () => {
    const profileEnv = {
      'ANTHROPIC_API_KEY': 'sk-profile-key',
      'ANTHROPIC_AUTH_TOKEN': 'profile-auth-token',
      'CLAUDE_CODE_OAUTH_TOKEN': 'profile-oauth-token'
    };

    const result = buildCleanEnvironment(inheritedEnv, profileEnv);

    // All auth vars from inherited env should pass through since profile set them
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test-key-12345');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('legacy-token');
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('should handle undefined values gracefully', () => {
    const mixedEnv: Record<string, string | undefined> = {
      'PATH': '/usr/bin',
      'ANTHROPIC_API_KEY': undefined,  // Explicitly undefined
      'CUSTOM_VAR': 'value',
      'ANTHROPIC_AUTH_TOKEN': 'token'
    };

    const profileEnv = {};

    const result = buildCleanEnvironment(mixedEnv, profileEnv);

    // Undefined should be filtered out
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();

    // Other vars should be present
    expect(result.PATH).toBe('/usr/bin');
    expect(result.CUSTOM_VAR).toBe('value');

    // Auth var should still be stripped (not set by profile)
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('should pass through non-auth environment variables unchanged', () => {
    const profileEnv = {};

    const result = buildCleanEnvironment(inheritedEnv, profileEnv);

    // Verify common env vars pass through
    expect(result.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.USER).toBe('testuser');
    expect(result.CUSTOM_VAR).toBe('custom-value');
    expect(result.NODE_ENV).toBe('production');
  });

  it('should work with empty environment', () => {
    const emptyEnv = {};
    const profileEnv = {};

    const result = buildCleanEnvironment(emptyEnv, profileEnv);

    expect(result).toEqual({});
  });

  it('should work with only auth vars', () => {
    const authOnlyEnv = {
      'ANTHROPIC_API_KEY': 'key',
      'ANTHROPIC_AUTH_TOKEN': 'token',
      'CLAUDE_CODE_OAUTH_TOKEN': 'oauth'
    };

    const profileEnv = {};

    const result = buildCleanEnvironment(authOnlyEnv, profileEnv);

    // All should be stripped
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should preserve auth var if profile sets just one of them', () => {
    const profileEnv = {
      'ANTHROPIC_AUTH_TOKEN': 'profile-token-override'  // Only this one
    };

    const result = buildCleanEnvironment(inheritedEnv, profileEnv);

    // ANTHROPIC_AUTH_TOKEN should be preserved (profile set it)
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('legacy-token');

    // Others should be stripped (profile didn't set them)
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

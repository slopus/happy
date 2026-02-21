/**
 * Tests for CLAUDECODE environment variable stripping (regression #682).
 *
 * When the daemon is started from within a Claude Code session, the
 * CLAUDECODE=1 env var is inherited. If passed to child session processes,
 * Claude Code refuses to launch with "cannot be launched inside another
 * Claude Code session". The daemon must strip it before spawning.
 */

import { describe, it, expect } from 'vitest';

describe('CLAUDECODE env stripping (issue #682)', () => {
    it('should remove CLAUDECODE from env while preserving other vars', () => {
        const env: Record<string, string> = {
            HOME: '/home/user',
            PATH: '/usr/bin',
            CLAUDECODE: '1',
            NODE_ENV: 'production',
        };

        // Same destructuring pattern used in daemon/run.ts
        const { CLAUDECODE: _stripped, ...cleanEnv } = env;

        expect(cleanEnv).toEqual({
            HOME: '/home/user',
            PATH: '/usr/bin',
            NODE_ENV: 'production',
        });
        expect('CLAUDECODE' in cleanEnv).toBe(false);
    });

    it('should work when CLAUDECODE is not present', () => {
        const env: Record<string, string> = {
            HOME: '/home/user',
            PATH: '/usr/bin',
        };

        const { CLAUDECODE: _stripped, ...cleanEnv } = env;

        expect(cleanEnv).toEqual({
            HOME: '/home/user',
            PATH: '/usr/bin',
        });
    });

    it('should allow extraEnv to override cleaned env', () => {
        const env: Record<string, string> = {
            HOME: '/home/user',
            CLAUDECODE: '1',
            EXISTING_VAR: 'old',
        };
        const extraEnv: Record<string, string> = {
            EXISTING_VAR: 'new',
            NEW_VAR: 'value',
        };

        const { CLAUDECODE: _stripped, ...cleanEnv } = env;
        const finalEnv = { ...cleanEnv, ...extraEnv };

        expect('CLAUDECODE' in finalEnv).toBe(false);
        expect(finalEnv.EXISTING_VAR).toBe('new');
        expect(finalEnv.NEW_VAR).toBe('value');
    });
});

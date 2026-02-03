/**
 * Unit tests for environment variable expansion utility
 */
import { describe, expect, it, vi } from 'vitest';

// Mock logger to avoid logger.warn/debug not being a function errors
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn()
    }
}));

import { expandEnvironmentVariables } from './expandEnvVars';

describe('expandEnvironmentVariables', () => {
    it('should expand simple ${VAR} reference', () => {
        const envVars = {
            TARGET: '${SOURCE}'
        };
        const sourceEnv = {
            SOURCE: 'value123'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'value123'
        });
    });

    it('should expand multiple ${VAR} references in same value', () => {
        const envVars = {
            PATH: '${BIN_DIR}:${LIB_DIR}'
        };
        const sourceEnv = {
            BIN_DIR: '/usr/bin',
            LIB_DIR: '/usr/lib'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            PATH: '/usr/bin:/usr/lib'
        });
    });

    it('should expand ${VAR} in middle of string', () => {
        const envVars = {
            MESSAGE: 'Hello ${NAME}, welcome!'
        };
        const sourceEnv = {
            NAME: 'World'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            MESSAGE: 'Hello World, welcome!'
        });
    });

    it('should handle authentication token expansion pattern', () => {
        const envVars = {
            ANTHROPIC_AUTH_TOKEN: '${Z_AI_AUTH_TOKEN}'
        };
        const sourceEnv = {
            Z_AI_AUTH_TOKEN: 'sk-ant-real-key-12345'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-key-12345'
        });
    });

    it('should preserve values without ${VAR} references', () => {
        const envVars = {
            STATIC: 'plain-value',
            NUMBER: '12345',
            PATH: '/usr/bin:/usr/lib'
        };
        const sourceEnv = {
            UNUSED: 'ignored'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            STATIC: 'plain-value',
            NUMBER: '12345',
            PATH: '/usr/bin:/usr/lib'
        });
    });

    it('should leave unexpanded ${VAR} when variable not found in source', () => {
        const envVars = {
            TARGET: '${MISSING_VAR}'
        };
        const sourceEnv = {
            OTHER: 'value'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: '${MISSING_VAR}'
        });
    });

    it('should handle partial expansion when some variables missing', () => {
        const envVars = {
            MIXED: '${EXISTS}:${MISSING}:${ALSO_EXISTS}'
        };
        const sourceEnv = {
            EXISTS: 'found1',
            ALSO_EXISTS: 'found2'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            MIXED: 'found1:${MISSING}:found2'
        });
    });

    it('should handle empty string values in source environment', () => {
        const envVars = {
            TARGET: '${EMPTY_VAR}'
        };
        const sourceEnv = {
            EMPTY_VAR: ''
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: ''
        });
    });

    it('should handle multiple variables with same source', () => {
        const envVars = {
            VAR1: '${SHARED}',
            VAR2: 'prefix-${SHARED}',
            VAR3: '${SHARED}-suffix'
        };
        const sourceEnv = {
            SHARED: 'common-value'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            VAR1: 'common-value',
            VAR2: 'prefix-common-value',
            VAR3: 'common-value-suffix'
        });
    });

    it('should not modify original envVars object', () => {
        const envVars = {
            TARGET: '${SOURCE}'
        };
        const sourceEnv = {
            SOURCE: 'value'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);

        // Original should be unchanged
        expect(envVars).toEqual({
            TARGET: '${SOURCE}'
        });

        // Result should be expanded
        expect(result).toEqual({
            TARGET: 'value'
        });
    });

    it('should use process.env as default source when not provided', () => {
        // Save original
        const originalPath = process.env.PATH;

        const envVars = {
            MY_PATH: '${PATH}'
        };

        const result = expandEnvironmentVariables(envVars);
        expect(result.MY_PATH).toBe(originalPath);
    });

    it('should handle nested braces correctly', () => {
        const envVars = {
            COMPLEX: '${VAR1}/${VAR2}/literal-${}'
        };
        const sourceEnv = {
            VAR1: 'part1',
            VAR2: 'part2'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            COMPLEX: 'part1/part2/literal-${}'
        });
    });

    it('should handle variables with underscores and numbers', () => {
        const envVars = {
            TARGET: '${MY_VAR_123}'
        };
        const sourceEnv = {
            MY_VAR_123: 'value-with-numbers'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            TARGET: 'value-with-numbers'
        });
    });

    it('should handle real-world profile environment variables scenario', () => {
        const profileEnvVars = {
            ANTHROPIC_AUTH_TOKEN: '${Z_AI_AUTH_TOKEN}',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            OPENAI_API_KEY: '${Z_OPENAI_KEY}',
            CUSTOM_PATH: '/custom:${HOME}/bin'
        };
        const daemonEnv = {
            Z_AI_AUTH_TOKEN: 'sk-ant-12345',
            Z_OPENAI_KEY: 'sk-proj-67890',
            HOME: '/Users/test'
        };

        const result = expandEnvironmentVariables(profileEnvVars, daemonEnv);
        expect(result).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-12345',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            OPENAI_API_KEY: 'sk-proj-67890',
            CUSTOM_PATH: '/custom:/Users/test/bin'
        });
    });

    it('should handle undefined source environment gracefully', () => {
        const envVars = {
            TARGET: '${MISSING}'
        };

        // undefined source should fall back to process.env
        const result = expandEnvironmentVariables(envVars, undefined as any);

        // Should return unexpanded since variable likely not in process.env
        expect(result.TARGET).toContain('${');
    });

    it('should handle empty objects', () => {
        const result = expandEnvironmentVariables({}, {});
        expect(result).toEqual({});
    });

    it('should not expand malformed ${} references', () => {
        const envVars = {
            BAD1: '${',
            BAD2: '${}',
            BAD3: 'text-${',
            GOOD: '${VALID}'
        };
        const sourceEnv = {
            VALID: 'expanded'
        };

        const result = expandEnvironmentVariables(envVars, sourceEnv);
        expect(result).toEqual({
            BAD1: '${',
            BAD2: '${}',
            BAD3: 'text-${',
            GOOD: 'expanded'
        });
    });
});

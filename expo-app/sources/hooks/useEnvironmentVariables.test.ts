import { describe, it, expect } from 'vitest';
import { extractEnvVarReferences, resolveEnvVarSubstitution } from './envVarUtils';

describe('extractEnvVarReferences', () => {
    it('extracts simple ${VAR} references', () => {
        const envVars = [{ name: 'TOKEN', value: '${API_KEY}' }];
        expect(extractEnvVarReferences(envVars)).toEqual(['API_KEY']);
    });

    it('extracts ${VAR:-default} references (bash parameter expansion)', () => {
        const envVars = [{ name: 'URL', value: '${BASE_URL:-https://api.example.com}' }];
        expect(extractEnvVarReferences(envVars)).toEqual(['BASE_URL']);
    });

    it('extracts ${VAR:=default} references (bash assignment)', () => {
        const envVars = [{ name: 'MODEL', value: '${MODEL:=gpt-4}' }];
        expect(extractEnvVarReferences(envVars)).toEqual(['MODEL']);
    });

    it('ignores literal values without substitution', () => {
        const envVars = [{ name: 'TIMEOUT', value: '30000' }];
        expect(extractEnvVarReferences(envVars)).toEqual([]);
    });

    it('handles mixed literal and substitution values', () => {
        const envVars = [
            { name: 'TIMEOUT', value: '30000' },
            { name: 'TOKEN', value: '${API_KEY}' },
            { name: 'URL', value: 'https://example.com' },
        ];
        expect(extractEnvVarReferences(envVars)).toEqual(['API_KEY']);
    });

    it('handles DeepSeek profile pattern', () => {
        const envVars = [
            { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
        ];
        expect(extractEnvVarReferences(envVars).sort()).toEqual(['DEEPSEEK_AUTH_TOKEN', 'DEEPSEEK_BASE_URL']);
    });

    it('handles Z.AI profile pattern', () => {
        const envVars = [
            { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://ai.zingdata.com/anthropic}' },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
            { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-Claude4}' },
        ];
        expect(extractEnvVarReferences(envVars).sort()).toEqual(['Z_AI_AUTH_TOKEN', 'Z_AI_BASE_URL', 'Z_AI_MODEL']);
    });

    it('returns empty array for undefined input', () => {
        expect(extractEnvVarReferences(undefined)).toEqual([]);
    });

    it('returns empty array for empty input', () => {
        expect(extractEnvVarReferences([])).toEqual([]);
    });

    it('deduplicates repeated variable references', () => {
        const envVars = [
            { name: 'TOKEN1', value: '${API_KEY}' },
            { name: 'TOKEN2', value: '${API_KEY}' },
        ];
        expect(extractEnvVarReferences(envVars)).toEqual(['API_KEY']);
    });
});

describe('resolveEnvVarSubstitution', () => {
    const daemonEnv = { API_KEY: 'sk-123', BASE_URL: 'https://custom.api.com', EMPTY: '' };

    it('resolves simple ${VAR} when present', () => {
        expect(resolveEnvVarSubstitution('${API_KEY}', daemonEnv)).toBe('sk-123');
    });

    it('returns null for missing simple ${VAR}', () => {
        expect(resolveEnvVarSubstitution('${MISSING}', daemonEnv)).toBeNull();
    });

    it('resolves ${VAR:-default} when VAR present', () => {
        expect(resolveEnvVarSubstitution('${BASE_URL:-https://default.com}', daemonEnv)).toBe('https://custom.api.com');
    });

    it('returns default when VAR missing in ${VAR:-default}', () => {
        expect(resolveEnvVarSubstitution('${MISSING:-fallback}', daemonEnv)).toBe('fallback');
    });

    it('returns default when VAR is null in ${VAR:-default}', () => {
        const envWithNull = { VAR: null as unknown as string };
        expect(resolveEnvVarSubstitution('${VAR:-fallback}', envWithNull)).toBe('fallback');
    });

    it('returns literal for non-substitution values', () => {
        expect(resolveEnvVarSubstitution('literal-value', daemonEnv)).toBe('literal-value');
    });

    it('returns literal URL for non-substitution', () => {
        expect(resolveEnvVarSubstitution('https://api.example.com', daemonEnv)).toBe('https://api.example.com');
    });

    it('handles ${VAR:=default} syntax', () => {
        expect(resolveEnvVarSubstitution('${MISSING:=assignment}', daemonEnv)).toBe('assignment');
    });

    it('resolves DeepSeek default URL pattern', () => {
        expect(resolveEnvVarSubstitution('${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}', {}))
            .toBe('https://api.deepseek.com/anthropic');
    });

    it('resolves actual value over default when present', () => {
        const env = { DEEPSEEK_BASE_URL: 'https://custom.deepseek.com' };
        expect(resolveEnvVarSubstitution('${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}', env))
            .toBe('https://custom.deepseek.com');
    });

    it('handles complex default values with special characters', () => {
        expect(resolveEnvVarSubstitution('${URL:-https://api.example.com/v1?key=value&foo=bar}', {}))
            .toBe('https://api.example.com/v1?key=value&foo=bar');
    });
});

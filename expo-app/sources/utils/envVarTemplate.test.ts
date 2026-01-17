import { describe, expect, it } from 'vitest';
import { formatEnvVarTemplate, parseEnvVarTemplate } from './envVarTemplate';

describe('envVarTemplate', () => {
    it('preserves := operator during parse/format round-trip', () => {
        const input = '${FOO:=bar}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: ':=', fallback: 'bar' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('preserves :- operator during parse/format round-trip', () => {
        const input = '${FOO:-bar}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: ':-', fallback: 'bar' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('round-trips templates without a fallback', () => {
        const input = '${FOO}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: null, fallback: '' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('formats an empty fallback when operator is explicitly provided', () => {
        expect(formatEnvVarTemplate({ sourceVar: 'FOO', operator: ':=', fallback: '' })).toBe('${FOO:=}');
        expect(formatEnvVarTemplate({ sourceVar: 'FOO', operator: ':-', fallback: '' })).toBe('${FOO:-}');
    });
});


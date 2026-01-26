import { describe, expect, it } from 'vitest';
import { isValidEnvVarKey, sanitizeEnvVarRecord, validateEnvVarRecordStrict } from './envVarSanitization';

describe('envVarSanitization', () => {
    it('rejects prototype-pollution keys', () => {
        expect(isValidEnvVarKey('__proto__')).toBe(false);
        expect(isValidEnvVarKey('constructor')).toBe(false);
        expect(isValidEnvVarKey('prototype')).toBe(false);
    });

    it('sanitizes records by filtering invalid keys and non-string values', () => {
        const out = sanitizeEnvVarRecord({
            GOOD: 'ok',
            ['__proto__']: 'bad',
            ALSO_OK: 123,
        } as any);
        expect(out).toEqual({ GOOD: 'ok' });
    });

    it('strictly validates records for spawning', () => {
        expect(validateEnvVarRecordStrict({ GOOD: 'ok' })).toEqual({ ok: true, env: { GOOD: 'ok' } });
        expect(validateEnvVarRecordStrict({ ['__proto__']: 'x' } as any)).toEqual({ ok: false, error: 'Invalid env var key: \"__proto__\"' });
        expect(validateEnvVarRecordStrict({ GOOD: 123 } as any)).toEqual({ ok: false, error: 'Invalid env var value for \"GOOD\": expected string' });
    });
});

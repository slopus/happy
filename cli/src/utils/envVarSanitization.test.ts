import { describe, expect, it } from 'vitest';
import { isValidEnvVarKey, sanitizeEnvVarRecord, validateEnvVarRecordStrict } from './envVarSanitization';

describe('envVarSanitization', () => {
    it('rejects prototype-pollution keys', () => {
        expect(isValidEnvVarKey('__proto__')).toBe(false);
        expect(isValidEnvVarKey('constructor')).toBe(false);
        expect(isValidEnvVarKey('prototype')).toBe(false);
    });

    it('sanitizes records by filtering invalid keys and non-string values', () => {
        const raw = Object.create(null) as any;
        raw.GOOD = 'ok';
        raw['__proto__'] = 'bad';
        raw.ALSO_OK = 123;

        const out = sanitizeEnvVarRecord(raw);
        expect(Object.getPrototypeOf(out)).toBe(null);
        expect(Object.fromEntries(Object.entries(out))).toEqual({ GOOD: 'ok' });
    });

    it('strictly validates records for spawning', () => {
        expect(validateEnvVarRecordStrict({ GOOD: 'ok' })).toEqual({ ok: true, env: { GOOD: 'ok' } });

        const protoKey = Object.create(null) as any;
        protoKey['__proto__'] = 'x';
        expect(validateEnvVarRecordStrict(protoKey)).toEqual({ ok: false, error: 'Invalid env var key: \"__proto__\"' });

        expect(validateEnvVarRecordStrict({ GOOD: 123 } as any)).toEqual({ ok: false, error: 'Invalid env var value for \"GOOD\": expected string' });
    });
});

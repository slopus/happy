import { describe, expect, it } from 'vitest';

import { resolveSessionRecordByPrefix } from './resolveHappySession';

describe('resolveSessionRecordByPrefix', () => {
    const sessions = [
        { id: 'cmmij8olq00dp5jcxr3wtbpau' },
        { id: 'cmmhiilo00dv7y7e8wjdr5s9x' },
    ];

    it('resolves an exact match', () => {
        expect(resolveSessionRecordByPrefix(sessions, 'cmmhiilo00dv7y7e8wjdr5s9x')).toEqual({
            id: 'cmmhiilo00dv7y7e8wjdr5s9x',
        });
    });

    it('resolves by unique prefix', () => {
        expect(resolveSessionRecordByPrefix(sessions, 'cmmij8')).toEqual({
            id: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('rejects unknown prefixes', () => {
        expect(() => resolveSessionRecordByPrefix(sessions, 'missing')).toThrow(
            'No Happy session found matching "missing"',
        );
    });

    it('rejects ambiguous prefixes', () => {
        expect(() => resolveSessionRecordByPrefix(sessions, 'cmm')).toThrow(
            'Ambiguous Happy session "cmm" matches 2 sessions. Be more specific.',
        );
    });
});

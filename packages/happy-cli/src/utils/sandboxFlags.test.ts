import { describe, expect, it } from 'vitest';
import { extractNoSandboxFlag } from './sandboxFlags';

describe('extractNoSandboxFlag', () => {
    it('returns noSandbox=true and strips the flag when present', () => {
        const parsed = extractNoSandboxFlag(['--started-by', 'daemon', '--no-sandbox', '--foo']);

        expect(parsed.noSandbox).toBe(true);
        expect(parsed.args).toEqual(['--started-by', 'daemon', '--foo']);
    });

    it('returns noSandbox=false and preserves args when flag is absent', () => {
        const parsed = extractNoSandboxFlag(['--started-by', 'terminal']);

        expect(parsed.noSandbox).toBe(false);
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });
});

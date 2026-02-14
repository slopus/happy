import { describe, expect, it } from 'vitest';
import { hackMode, hackModes } from './modeHacks';

describe('modeHacks', () => {
    it('capitalizes plan/build when key and name are lowercase', () => {
        expect(hackMode({ key: 'build', name: 'build', description: null }).name).toBe('Build');
        expect(hackMode({ key: 'plan', name: 'plan', description: null }).name).toBe('Plan');
    });

    it('normalizes build and plan duplicated labels', () => {
        expect(hackMode({ key: 'build', name: 'build, build', description: null }).name).toBe('Build');
        expect(hackMode({ key: 'plan', name: 'plan/plan', description: null }).name).toBe('Plan');
    });

    it('keeps unmodified modes unchanged', () => {
        const mode = { key: 'default', name: 'Default', description: 'Ask for permissions' };
        expect(hackMode(mode)).toEqual(mode);
    });

    it('applies hacks across mode arrays', () => {
        expect(hackModes([
            { key: 'build', name: 'build', description: null },
            { key: 'plan', name: 'plan', description: null },
        ])).toEqual([
            { key: 'build', name: 'Build', description: null },
            { key: 'plan', name: 'Plan', description: null },
        ]);
    });
});

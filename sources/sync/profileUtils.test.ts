import { describe, expect, it } from 'vitest';
import { getProfilePrimaryCli } from './profileUtils';

describe('getProfilePrimaryCli', () => {
    it('ignores unknown compatibility keys', () => {
        const profile = {
            compatibility: { unknownCli: true },
        } as any;

        expect(getProfilePrimaryCli(profile)).toBe('none');
    });
});


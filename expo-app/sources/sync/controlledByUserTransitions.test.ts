import { describe, expect, it } from 'vitest';

import { didControlReturnToMobile } from './controlledByUserTransitions';

describe('didControlReturnToMobile', () => {
    it('returns true when controlledByUser flips from true to false', () => {
        expect(didControlReturnToMobile(true, false)).toBe(true);
    });

    it('returns true when controlledByUser flips from true to nullish', () => {
        expect(didControlReturnToMobile(true, null)).toBe(true);
        expect(didControlReturnToMobile(true, undefined)).toBe(true);
    });

    it('returns false for all other transitions', () => {
        expect(didControlReturnToMobile(false, true)).toBe(false);
        expect(didControlReturnToMobile(false, false)).toBe(false);
        expect(didControlReturnToMobile(undefined, true)).toBe(false);
        expect(didControlReturnToMobile(undefined, undefined)).toBe(false);
        expect(didControlReturnToMobile(null, false)).toBe(false);
    });
});


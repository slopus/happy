import { describe, expect, it } from 'vitest';

import { resolveCustomProjectPathSelection } from './homeDockInteraction';

describe('HomeDock interaction lifecycle', () => {
    it('ignores a custom-project prompt result after HomeDock unmounts', () => {
        expect(resolveCustomProjectPathSelection('~/project', false)).toBeNull();
    });

    it('trims a mounted custom-project prompt result', () => {
        expect(resolveCustomProjectPathSelection('  ~/project  ', true)).toBe('~/project');
        expect(resolveCustomProjectPathSelection('   ', true)).toBeNull();
    });
});

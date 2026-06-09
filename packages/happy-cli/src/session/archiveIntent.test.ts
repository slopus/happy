import { describe, expect, it } from 'vitest';
import { shouldPostArchiveEndpoint } from './archiveIntent';

describe('shouldPostArchiveEndpoint', () => {
    it('posts archive only for explicit archive cleanup', () => {
        expect(shouldPostArchiveEndpoint({ archive: true })).toBe(true);
        expect(shouldPostArchiveEndpoint({ archive: false })).toBe(false);
    });

    it('preserves archived cleanup as the default for crash handlers', () => {
        expect(shouldPostArchiveEndpoint({})).toBe(true);
    });
});

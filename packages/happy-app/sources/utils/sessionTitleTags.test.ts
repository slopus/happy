import { describe, expect, it } from 'vitest';
import { findSessionTitleTagQuery, removeSessionTitleTagQuery } from './sessionTitleTags';

describe('sessionTitleTags', () => {
    it('finds a trailing tag command at a word boundary', () => {
        expect(findSessionTitleTagQuery('Roadmap #pro')).toEqual({
            query: 'pro',
            start: 8,
        });
        expect(findSessionTitleTagQuery('#')).toEqual({ query: '', start: 0 });
    });

    it('does not treat a hash inside normal text as a tag command', () => {
        expect(findSessionTitleTagQuery('C# notes')).toBeNull();
        expect(findSessionTitleTagQuery('Roadmap #pro draft')).toBeNull();
    });

    it('removes the command without leaving tag text in the title', () => {
        expect(removeSessionTitleTagQuery('Roadmap #product', 8)).toBe('Roadmap');
        expect(removeSessionTitleTagQuery('#product', 0)).toBe('');
    });
});

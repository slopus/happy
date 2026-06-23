import { describe, it, expect } from 'vitest';
import { filterPickerItems } from './filterPickerItems';

const items = [
    { key: '/Users/jane/Code/happy', label: '~/Code/happy' },
    { key: '/Users/jane/Code/seneca', label: '~/Code/seneca' },
    { key: '/Users/jane/work/api', label: '~/work/api' },
];

describe('filterPickerItems', () => {
    it('returns all items for an empty or whitespace query', () => {
        expect(filterPickerItems(items, '')).toEqual(items);
        expect(filterPickerItems(items, '   ')).toEqual(items);
    });

    it('matches on the label, case-insensitively', () => {
        expect(filterPickerItems(items, 'HAPPY').map((i) => i.label)).toEqual(['~/Code/happy']);
    });

    it('matches on the full key path too', () => {
        expect(filterPickerItems(items, '/work/').map((i) => i.label)).toEqual(['~/work/api']);
    });

    it('returns multiple matches when the query is a shared fragment', () => {
        expect(filterPickerItems(items, 'code').map((i) => i.label)).toEqual([
            '~/Code/happy',
            '~/Code/seneca',
        ]);
    });

    it('returns an empty array when nothing matches', () => {
        expect(filterPickerItems(items, 'zzz')).toEqual([]);
    });
});

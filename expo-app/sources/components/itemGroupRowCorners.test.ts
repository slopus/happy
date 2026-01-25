import { describe, expect, it } from 'vitest';
import { getItemGroupRowCornerRadii } from './itemGroupRowCorners';

describe('getItemGroupRowCornerRadii', () => {
    it('returns empty when there is no background', () => {
        expect(getItemGroupRowCornerRadii({ hasBackground: false, position: { isFirst: true, isLast: true }, radius: 16 })).toEqual({});
    });

    it('returns empty when position is missing', () => {
        expect(getItemGroupRowCornerRadii({ hasBackground: true, position: null, radius: 16 })).toEqual({});
    });

    it('applies top corners for first row', () => {
        expect(getItemGroupRowCornerRadii({ hasBackground: true, position: { isFirst: true, isLast: false }, radius: 16 }))
            .toEqual({ borderTopLeftRadius: 16, borderTopRightRadius: 16 });
    });

    it('applies bottom corners for last row', () => {
        expect(getItemGroupRowCornerRadii({ hasBackground: true, position: { isFirst: false, isLast: true }, radius: 16 }))
            .toEqual({ borderBottomLeftRadius: 16, borderBottomRightRadius: 16 });
    });

    it('applies all corners for a single-row group', () => {
        expect(getItemGroupRowCornerRadii({ hasBackground: true, position: { isFirst: true, isLast: true }, radius: 16 }))
            .toEqual({
                borderTopLeftRadius: 16,
                borderTopRightRadius: 16,
                borderBottomLeftRadius: 16,
                borderBottomRightRadius: 16,
            });
    });
});


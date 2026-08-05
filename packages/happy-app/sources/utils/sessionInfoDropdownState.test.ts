import { describe, expect, it } from 'vitest';
import { canKeepSessionInfoExpansion } from './sessionInfoDropdownState';

describe('canKeepSessionInfoExpansion', () => {
    const allEditable = { permission: true, model: true, effort: true };

    it('keeps an editable option list open', () => {
        expect(canKeepSessionInfoExpansion('model', allEditable)).toBe(true);
    });

    it.each(['permission', 'model', 'effort'] as const)(
        'closes the %s list as soon as that row becomes unavailable',
        (expanded) => {
            expect(canKeepSessionInfoExpansion(expanded, {
                ...allEditable,
                [expanded]: false,
            })).toBe(false);
        },
    );

    it('accepts the already-collapsed state even when every row is unavailable', () => {
        expect(canKeepSessionInfoExpansion(null, {
            permission: false,
            model: false,
            effort: false,
        })).toBe(true);
    });
});

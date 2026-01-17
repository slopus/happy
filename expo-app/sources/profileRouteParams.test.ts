import { describe, expect, it } from 'vitest';
import { consumeProfileIdParam } from './profileRouteParams';

describe('consumeProfileIdParam', () => {
    it('does nothing when param is missing', () => {
        expect(consumeProfileIdParam({ profileIdParam: undefined, selectedProfileId: null })).toEqual({
            nextSelectedProfileId: undefined,
            shouldClearParam: false,
        });
    });

    it('clears param and deselects when param is empty string', () => {
        expect(consumeProfileIdParam({ profileIdParam: '', selectedProfileId: 'abc' })).toEqual({
            nextSelectedProfileId: null,
            shouldClearParam: true,
        });
    });

    it('clears param without changing selection when it matches current selection', () => {
        expect(consumeProfileIdParam({ profileIdParam: 'abc', selectedProfileId: 'abc' })).toEqual({
            nextSelectedProfileId: undefined,
            shouldClearParam: true,
        });
    });

    it('clears param and selects when it differs from current selection', () => {
        expect(consumeProfileIdParam({ profileIdParam: 'next', selectedProfileId: 'abc' })).toEqual({
            nextSelectedProfileId: 'next',
            shouldClearParam: true,
        });
    });

    it('accepts array params and uses the first value', () => {
        expect(consumeProfileIdParam({ profileIdParam: ['next', 'ignored'], selectedProfileId: null })).toEqual({
            nextSelectedProfileId: 'next',
            shouldClearParam: true,
        });
    });

    it('treats empty array params as missing', () => {
        expect(consumeProfileIdParam({ profileIdParam: [], selectedProfileId: null })).toEqual({
            nextSelectedProfileId: undefined,
            shouldClearParam: false,
        });
    });
});

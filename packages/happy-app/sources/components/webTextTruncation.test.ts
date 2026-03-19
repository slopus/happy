import { describe, expect, it } from 'vitest';
import { isWebTextTruncated } from './webTextTruncation';

describe('isWebTextTruncated', () => {
    it('returns true when the scroll height exceeds the client height', () => {
        expect(isWebTextTruncated({
            clientHeight: 120,
            scrollHeight: 168,
        })).toBe(true);
    });

    it('returns false when the heights are effectively equal', () => {
        expect(isWebTextTruncated({
            clientHeight: 120,
            scrollHeight: 120.5,
        })).toBe(false);
    });

    it('returns true when the scroll width exceeds the client width', () => {
        expect(isWebTextTruncated({
            clientWidth: 220,
            scrollWidth: 264,
        })).toBe(true);
    });

    it('returns false when the widths are effectively equal', () => {
        expect(isWebTextTruncated({
            clientWidth: 220,
            scrollWidth: 220.5,
        })).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { getEmptyMainScreenMode } from './emptyMainScreenMode';

describe('getEmptyMainScreenMode', () => {
    it('returns start-session when at least one machine is online', () => {
        expect(getEmptyMainScreenMode(true)).toBe('start-session');
    });

    it('returns connect-device when no machine is online', () => {
        expect(getEmptyMainScreenMode(false)).toBe('connect-device');
    });
});

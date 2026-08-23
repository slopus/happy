import { describe, expect, it } from 'vitest';
import { shouldShowHomeConnectionStatus } from './homeConnectionStatus';

describe('shouldShowHomeConnectionStatus', () => {
    it.each([
        ['connecting', true],
        ['disconnected', true],
        ['error', true],
        ['connected', false],
    ] as const)('shows the %s state as needed', (status, expected) => {
        expect(shouldShowHomeConnectionStatus(status)).toBe(expected);
    });

    it('keeps custom subtitles in charge of the secondary line', () => {
        expect(shouldShowHomeConnectionStatus('connecting', true)).toBe(false);
        expect(shouldShowHomeConnectionStatus('connected', true)).toBe(false);
    });
});
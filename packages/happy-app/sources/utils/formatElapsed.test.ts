import { describe, expect, it } from 'vitest';
import { formatElapsed } from './formatElapsed';

describe('formatElapsed', () => {
    it('shows whole seconds under a minute', () => {
        expect(formatElapsed(0)).toBe('0s');
        expect(formatElapsed(8)).toBe('8s');
        expect(formatElapsed(59)).toBe('59s');
    });

    it('switches to minutes with zero-padded seconds', () => {
        expect(formatElapsed(60)).toBe('1m 00s');
        expect(formatElapsed(65)).toBe('1m 05s');
        expect(formatElapsed(3725)).toBe('62m 05s');
    });

    it('never shows a fraction or a negative value', () => {
        expect(formatElapsed(8.7)).toBe('8s');
        expect(formatElapsed(-3)).toBe('0s');
    });
});

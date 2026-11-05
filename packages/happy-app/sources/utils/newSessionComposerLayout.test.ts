import { describe, expect, it } from 'vitest';
import { getNewSessionInputMaxHeight } from './newSessionComposerLayout';

describe('new session Web prompt height', () => {
    it('shrinks a long phone prompt when the keyboard opens and restores it when closed', () => {
        const closed = getNewSessionInputMaxHeight(844, true);
        const open = getNewSessionInputMaxHeight(300, true);
        expect(closed).toBe(120);
        expect(open).toBe(80);
        expect(open + 220).toBeLessThanOrEqual(300);
        expect(getNewSessionInputMaxHeight(844, true)).toBe(closed);
    });

    it('keeps a two-line minimum on very short viewports', () => {
        expect(getNewSessionInputMaxHeight(240, true)).toBe(44);
    });

    it('keeps the desktop cap but reserves controls when the window becomes short', () => {
        expect(getNewSessionInputMaxHeight(900, false)).toBe(480);
        expect(getNewSessionInputMaxHeight(420, false)).toBe(200);
    });
});

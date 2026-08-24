import { describe, expect, it } from 'vitest';
import {
    MOBILE_GLASS_CONTROL_SIZE,
    MOBILE_TITLE_PILL_GAP,
    resolveTitlePillInset,
} from './headerMetrics';

describe('resolveTitlePillInset', () => {
    it('clears the back button by the full gap', () => {
        expect(resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: MOBILE_GLASS_CONTROL_SIZE,
        })).toBe(MOBILE_GLASS_CONTROL_SIZE + MOBILE_TITLE_PILL_GAP);
    });

    // The right control carries a variable payload. Growing it must move the
    // title, not let the title run underneath it.
    it('follows the wider control on both sides so the pill stays centred', () => {
        const inset = resolveTitlePillInset({
            leftControlWidth: MOBILE_GLASS_CONTROL_SIZE,
            rightControlWidth: 96,
        });
        expect(inset).toBe(96 + MOBILE_TITLE_PILL_GAP);
    });

    it('still keeps the gap when a side has no control at all', () => {
        expect(resolveTitlePillInset({
            leftControlWidth: 0,
            rightControlWidth: 0,
        })).toBe(MOBILE_TITLE_PILL_GAP);
    });

    it('never leaves less than the gap on either side', () => {
        const widths = [0, 12, MOBILE_GLASS_CONTROL_SIZE, 88, 140];
        for (const leftControlWidth of widths) {
            for (const rightControlWidth of widths) {
                const inset = resolveTitlePillInset({ leftControlWidth, rightControlWidth });
                expect(inset - leftControlWidth).toBeGreaterThanOrEqual(MOBILE_TITLE_PILL_GAP);
                expect(inset - rightControlWidth).toBeGreaterThanOrEqual(MOBILE_TITLE_PILL_GAP);
            }
        }
    });
});

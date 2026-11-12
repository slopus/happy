import { describe, expect, it } from 'vitest';
import { composerTooltipPosition } from './composerTooltipPosition';

const hint = { width: 160, height: 32 };
const viewport = { width: 800, height: 600 };
function rect(anchor: { left: number; top: number; width: number; height: number }) {
    const host = composerTooltipPosition(anchor, hint, viewport);
    return { left: host.left + host.width / 2 - hint.width / 2, top: host.top - hint.height - 8 };
}

describe('composerTooltipPosition', () => {
    it('centers above a normal control with an eight pixel gap', () => {
        expect(rect({ left: 300, top: 500, width: 40, height: 32 })).toEqual({ left: 240, top: 460 });
    });
    it.each([0, 760])('keeps an edge control hint wholly inside the viewport (%s)', left => {
        const position = rect({ left, top: 500, width: 40, height: 32 });
        expect(position.left).toBeGreaterThanOrEqual(8);
        expect(position.left + hint.width).toBeLessThanOrEqual(viewport.width - 8);
    });
    it('flips below a control when the top of the viewport has no room', () => {
        expect(rect({ left: 300, top: 8, width: 40, height: 32 }).top).toBe(48);
    });
    it('keeps a scrolled-offscreen control hint within the vertical viewport', () => {
        const position = rect({ left: 300, top: 650, width: 40, height: 32 });
        expect(position.top).toBeGreaterThanOrEqual(8);
        expect(position.top + hint.height).toBeLessThanOrEqual(viewport.height - 8);
    });
});

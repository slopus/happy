import { describe, expect, it } from 'vitest';
import { getWorkspaceChatWidth } from './documentPresentation';

describe('workspace chat allocation', () => {
    it('leaves room for the document when both sidebars are open', () => {
        const rowWidth = 946;
        const rightPanelWidth = 320;
        const chat = getWorkspaceChatWidth(430, rowWidth, rightPanelWidth);
        expect(chat).toBe(376);
        expect(rowWidth - rightPanelWidth - 10 - chat).toBeGreaterThanOrEqual(240);
    });

    it('preserves the preferred width when there is room, including after collapsing the panel', () => {
        expect(getWorkspaceChatWidth(430, 1600, 320)).toBe(430);
        expect(getWorkspaceChatWidth(430, 946, 0)).toBe(430);
        expect(getWorkspaceChatWidth(430, 0, 0)).toBe(430);
    });

    it('lets the document shrink beyond the midpoint and the old 800px chat ceiling', () => {
        expect(getWorkspaceChatWidth(1200, 2000, 320)).toBe(1200);
        expect(getWorkspaceChatWidth(1900, 2000, 320)).toBe(1430);
    });

    it('clamps to the visible space while retaining a wider preference for a larger window', () => {
        expect(getWorkspaceChatWidth(1200, 946, 320)).toBe(376);
        expect(getWorkspaceChatWidth(1200, 2000, 320)).toBe(1200);
        expect(getWorkspaceChatWidth(0, 2000, 320)).toBe(310);
    });

    it('keeps the chat usable without overflowing when both panels leave less than the combined minimum', () => {
        const chat = getWorkspaceChatWidth(1200, 800, 320);
        expect(chat).toBe(310);
        expect(800 - 320 - 10 - chat).toBe(160);
    });
});

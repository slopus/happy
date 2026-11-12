import { describe, expect, it } from 'vitest';
import { getProjectCatalogWidth, getProjectChatWidth, getProjectChatMaximumWidth, getProjectTaskNavigationWidth, canSplitProjectFile } from './projectWorkspaceLayout';

describe('project three-column allocation', () => {
    it('shares the space at laptop widths instead of squeezing the conversation', () => {
        expect(getProjectChatWidth(undefined, 1480, 320)).toBe(570);
        expect(getProjectChatWidth(undefined, 980, 294)).toBe(333);
    });
    it('caps the default file width on large screens while giving the remaining space to chat', () => {
        const chat = getProjectChatWidth(undefined, 2220, 320);
        expect(chat).toBe(1120);
        expect(2220 - 320 - 20 - chat).toBe(760);
    });
    it('honors a manual split and reserves the file minimum within the actual row gaps', () => {
        expect(getProjectChatWidth(430, 2220, 320)).toBe(430);
        expect(getProjectChatWidth(1500, 1480, 320)).toBe(900);
        expect(getProjectChatMaximumWidth(1480, 320)).toBe(900);
    });
    it('reserves a readable task index before splitting conversation and file space', () => {
        expect(getProjectTaskNavigationWidth(1600)).toBe(264);
        expect(getProjectTaskNavigationWidth(1040)).toBe(220);
        expect(canSplitProjectFile(1600, 320, 264)).toBe(true);
        expect(canSplitProjectFile(1120, 320, 220)).toBe(false);
        expect(canSplitProjectFile(1280, 320, 0)).toBe(true);
    });
});

it('keeps cards and a readable center within the desktop work area', () => {
    for (const [row, right] of [[1010, 303], [1180, 320], [1580, 320], [1820, 340]]) {
        const cards = getProjectCatalogWidth(row, right);
        expect(cards).toBeGreaterThanOrEqual(280);
        expect(cards).toBeLessThanOrEqual(620);
        expect(row - right - 20 - cards).toBeGreaterThanOrEqual(360);
    }
    expect(getProjectCatalogWidth(1580, 320)).toBeGreaterThanOrEqual(554);
    expect(getProjectCatalogWidth(0, 320)).toBe(0);
});

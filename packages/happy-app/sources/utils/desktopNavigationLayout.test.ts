import { describe, expect, it } from 'vitest';
import {
    getDesktopSidebarWidth,
    getDesktopRightPanelWidth,
    isDesktopRightPanelAvailable,
    getPersistentHeaderPointerEvents,
    getPersistentHeaderContentInset,
    getPersistentNavigationControlsWidth,
} from './desktopNavigationLayout';

describe('desktopNavigationLayout', () => {
    it.each([
        { width: 799, expected: 0 },
        { width: 800, expected: 250 },
        { width: 1280, expected: 360 },
        { width: 1600, expected: 360 },
    ])('calculates the desktop sidebar width at $width px', ({ width, expected }) => {
        expect(getDesktopSidebarWidth(width)).toBe(expected);
    });

    it.each([
        { width: 1099, expected: 0 },
        { width: 1100, expected: 280 },
        { width: 1280, expected: 307 },
        { width: 1500, expected: 360 },
    ])('calculates a compact desktop right panel width at $width px', ({ width, expected }) => {
        expect(getDesktopRightPanelWidth(width)).toBe(expected);
    });

    it('only enables the persistent right panel for supported wide desktop layouts', () => {
        expect(isDesktopRightPanelAvailable({
            isTablet: true,
            supportsPersistentPanel: true,
            windowWidth: 1100,
        })).toBe(true);
        expect(isDesktopRightPanelAvailable({
            isTablet: true,
            supportsPersistentPanel: true,
            windowWidth: 1099,
        })).toBe(false);
        expect(isDesktopRightPanelAvailable({
            isTablet: false,
            supportsPersistentPanel: true,
            windowWidth: 1440,
        })).toBe(false);
        expect(isDesktopRightPanelAvailable({
            isTablet: true,
            supportsPersistentPanel: false,
            windowWidth: 1440,
        })).toBe(false);
    });

    it('calculates the rendered controls width from the real button geometry', () => {
        expect(getPersistentNavigationControlsWidth(3)).toBe(92);
        expect(getPersistentNavigationControlsWidth(2)).toBe(60);
    });

    it.each([
        { isWeb: true, inTauri: false, expected: 'none' },
        { isWeb: true, inTauri: true, expected: 'box-none' },
        { isWeb: false, inTauri: false, expected: 'box-none' },
    ] as const)(
        'uses $expected pointer events for isWeb=$isWeb, inTauri=$inTauri',
        ({ isWeb, inTauri, expected }) => {
            expect(getPersistentHeaderPointerEvents({ isWeb, inTauri })).toBe(expected);
        },
    );

    it.each([
        { width: 800, expected: 114 },
        { width: 1280, expected: 54 },
        { width: 1470, expected: 0 },
    ])('only reserves the Web header area that overlaps at $width px', ({ width, expected }) => {
        expect(getPersistentHeaderContentInset({
            windowWidth: width,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            buttonCount: 3,
            targetHitSlop: 8,
        })).toBe(expected);
    });

    it('calculates the header inset against the full viewport in Zen mode', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1280,
            headerMaxWidth: Number.POSITIVE_INFINITY,
            headerHorizontalPadding: 16,
            sidebarVisible: false,
            buttonCount: 3,
            targetHitSlop: 8,
        })).toBe(114);
    });

    it('uses the exact width for labeled desktop controls', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1280,
            headerMaxWidth: Number.POSITIVE_INFINITY,
            headerHorizontalPadding: 16,
            sidebarVisible: false,
            buttonCount: 3,
            controlsWidth: 236,
            targetHitSlop: 8,
        })).toBe(258);
    });

    it('reserves navigation space when the desktop file panel narrows the session header', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1470,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            rightPanelWidth: 360,
            controlStartPadding: 16,
            buttonCount: 3,
            targetHitSlop: 8,
        })).toBe(130);
    });
});

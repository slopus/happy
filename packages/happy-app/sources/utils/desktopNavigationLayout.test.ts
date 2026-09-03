import { describe, expect, it } from 'vitest';
import {
    DESKTOP_LEFT_PANEL_MAX_WIDTH,
    DESKTOP_MAIN_MIN_WIDTH,
    DESKTOP_RIGHT_PANEL_MAX_WIDTH,
    getDesktopPanelResizeWidth,
    getDesktopPanelShortcutPresentation,
    getDesktopSidebarWidth,
    getDesktopRightPanelWidth,
    getDesktopRightPanelPresentation,
    getResponsiveRightPanelMode,
    isDesktopRightPanelAvailable,
    shouldUseCompactSessionHeader,
    getPersistentHeaderPointerEvents,
    getPersistentHeaderContentInset,
    getPersistentNavigationControlsWidth,
    getDesktopWorkspacePanelWidths,
    isDesktopRightPanelRoute,
    PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
    supportsDesktopComposerModeSelector,
} from './desktopNavigationLayout';

describe('desktopNavigationLayout', () => {
    it.each([
        { width: 390, expected: 'edge-handle' },
        { width: 500, expected: 'edge-handle' },
        { width: 799, expected: 'edge-handle' },
        { width: 800, expected: 'drawer-toggle' },
        { width: 1024, expected: 'drawer-toggle' },
        { width: 1280, expected: 'persistent' },
        { width: 1440, expected: 'persistent' },
        { width: 1920, expected: 'persistent' },
    ] as const)('uses $expected right-panel access at $width px', ({ width, expected }) => {
        expect(getResponsiveRightPanelMode(width)).toBe(expected);
    });

    it.each([
        { isWeb: true, windowWidth: 799, expected: false },
        { isWeb: true, windowWidth: 800, expected: true },
        { isWeb: false, windowWidth: 1280, expected: false },
    ])('shows desktop composer modes=$expected for web=$isWeb at $windowWidth px', ({ isWeb, windowWidth, expected }) => {
        expect(supportsDesktopComposerModeSelector({ isWeb, windowWidth })).toBe(expected);
    });

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

    it('keeps the middle workspace at its minimum while fitting both requested panel widths', () => {
        const widths = getDesktopWorkspacePanelWidths({
            leftVisible: true,
            requestedLeftWidth: 640,
            requestedRightWidth: 640,
            rightVisible: true,
            windowWidth: 1280,
        });

        expect(widths.left + widths.main + widths.right).toBe(1280);
        expect(widths.main).toBe(DESKTOP_MAIN_MIN_WIDTH);
        expect(widths.left).toBeGreaterThanOrEqual(250);
        expect(widths.right).toBeGreaterThanOrEqual(280);
    });

    it('caps one visible panel when the opposite panel is hidden', () => {
        expect(getDesktopWorkspacePanelWidths({
            leftVisible: true,
            requestedLeftWidth: 640,
            requestedRightWidth: 640,
            rightVisible: false,
            windowWidth: 1280,
        })).toEqual({
            left: DESKTOP_LEFT_PANEL_MAX_WIDTH,
            main: 1280 - DESKTOP_LEFT_PANEL_MAX_WIDTH,
            right: 0,
        });
    });

    it('clamps the actively resized panel to its fixed maximum and the available workspace', () => {
        expect(getDesktopPanelResizeWidth({
            desiredWidth: 900,
            oppositePanelVisible: true,
            oppositePanelWidth: 320,
            side: 'left',
            windowWidth: 1280,
        })).toBe(480);
        expect(getDesktopPanelResizeWidth({
            desiredWidth: 900,
            oppositePanelVisible: false,
            oppositePanelWidth: 320,
            side: 'left',
            windowWidth: 1280,
        })).toBe(DESKTOP_LEFT_PANEL_MAX_WIDTH);
        expect(getDesktopPanelResizeWidth({
            desiredWidth: 1500,
            oppositePanelVisible: true,
            oppositePanelWidth: 320,
            side: 'left',
            windowWidth: 1920,
        })).toBe(DESKTOP_LEFT_PANEL_MAX_WIDTH);
        expect(getDesktopPanelResizeWidth({
            desiredWidth: 1500,
            oppositePanelVisible: false,
            oppositePanelWidth: 360,
            side: 'right',
            windowWidth: 1920,
        })).toBe(DESKTOP_RIGHT_PANEL_MAX_WIDTH);
    });

    it('renders platform-correct shortcut hints and ARIA tokens', () => {
        expect(getDesktopPanelShortcutPresentation('MacIntel')).toEqual({
            leftAria: 'Meta+B',
            leftLabel: '⌘B',
            rightAria: 'Alt+Meta+B',
            rightLabel: '⌥⌘B',
        });
        expect(getDesktopPanelShortcutPresentation('Win32')).toEqual({
            leftAria: 'Control+B',
            leftLabel: 'Ctrl+B',
            rightAria: 'Alt+Control+B',
            rightLabel: 'Alt+Ctrl+B',
        });
    });

    it.each([
        ['/', true],
        ['/new', true],
        ['/session/abc', true],
        ['/session/abc/', true],
        ['/session/search', false],
        ['/session/abc/info', false],
        ['/settings', false],
    ] as const)('resolves right-panel support for route %s', (pathname, expected) => {
        expect(isDesktopRightPanelRoute(pathname)).toBe(expected);
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

    it.each([
        { isTablet: true, width: 1179, expected: true },
        { isTablet: true, width: 1180, expected: false },
        { isTablet: false, width: 1100, expected: false },
    ])('sets compact session metadata to $expected at $width px', ({ isTablet, width, expected }) => {
        expect(shouldUseCompactSessionHeader({ isTablet, windowWidth: width })).toBe(expected);
    });

    it.each([
        { available: false, collapsed: false, zenMode: false, expected: 'unavailable' },
        { available: true, collapsed: false, zenMode: true, expected: 'zen' },
        { available: true, collapsed: true, zenMode: false, expected: 'collapsed' },
        { available: true, collapsed: false, zenMode: false, expected: 'expanded' },
    ] as const)(
        'resolves $expected for available=$available collapsed=$collapsed zenMode=$zenMode',
        ({ available, collapsed, zenMode, expected }) => {
            expect(getDesktopRightPanelPresentation({
                available,
                collapsed,
                zenMode,
            })).toBe(expected);
        },
    );

    it('calculates the rendered controls width from the real button geometry', () => {
        expect(getPersistentNavigationControlsWidth(4)).toBe(172);
        expect(getPersistentNavigationControlsWidth(3)).toBe(128);
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
        { width: 800, expected: 194 },
        { width: 1280, expected: 134 },
        { width: 1470, expected: 39 },
    ])('only reserves the Web header area that overlaps at $width px', ({ width, expected }) => {
        expect(getPersistentHeaderContentInset({
            windowWidth: width,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            buttonCount: 4,
            targetHitSlop: 8,
        })).toBe(expected);
    });

    it('calculates the header inset against the full viewport in Zen mode', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1280,
            headerMaxWidth: Number.POSITIVE_INFINITY,
            headerHorizontalPadding: 16,
            sidebarVisible: false,
            buttonCount: 4,
            targetHitSlop: 8,
        })).toBe(194);
    });

    it('uses the exact width for labeled desktop controls', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1280,
            headerMaxWidth: Number.POSITIVE_INFINITY,
            headerHorizontalPadding: 16,
            sidebarVisible: false,
            buttonCount: 4,
            controlsWidth: PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
            targetHitSlop: 8,
        })).toBe(194);
    });

    it('uses a resized sidebar width when protecting header controls', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1280,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            sidebarVisible: true,
            sidebarWidth: 480,
            buttonCount: 4,
            controlsWidth: PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH,
            targetHitSlop: 8,
        })).toBe(194);
    });

    it('reserves navigation space when the desktop file panel narrows the session header', () => {
        expect(getPersistentHeaderContentInset({
            windowWidth: 1470,
            headerMaxWidth: 800,
            headerHorizontalPadding: 16,
            rightPanelWidth: 360,
            controlStartPadding: 16,
            buttonCount: 4,
            targetHitSlop: 8,
        })).toBe(210);
    });
});

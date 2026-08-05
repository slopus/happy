export const WEB_TABLET_MIN_WIDTH = 800;
export const DESKTOP_RIGHT_PANEL_MIN_WINDOW_WIDTH = 1100;
export const DESKTOP_SESSION_HEADER_COMPACT_WINDOW_WIDTH = 1180;
export const DESKTOP_MAIN_MIN_WIDTH = 480;
export const DESKTOP_LEFT_PANEL_MIN_WIDTH = 250;
export const DESKTOP_LEFT_PANEL_MAX_WIDTH = 640;
export const DESKTOP_LEFT_PANEL_DEFAULT_WIDTH = 360;
export const DESKTOP_RIGHT_PANEL_MIN_WIDTH = 280;
export const DESKTOP_RIGHT_PANEL_MAX_WIDTH = 640;
export const DESKTOP_RIGHT_PANEL_DEFAULT_WIDTH = 320;
export const PERSISTENT_NAVIGATION_HORIZONTAL_PADDING = 16;
export const PERSISTENT_NAVIGATION_BUTTON_SIZE = 28;
export const PERSISTENT_NAVIGATION_BUTTON_GAP = 4;
export const PERSISTENT_NAVIGATION_HIT_SLOP = 10;
export const PERSISTENT_NAVIGATION_TARGET_GAP = 4;
export const TAURI_HEADER_CONTROL_LEFT = 92;
export const PERSISTENT_NAVIGATION_SIDEBAR_CONTROL_WIDTH = 92;
export const PERSISTENT_NAVIGATION_ZEN_CONTROL_WIDTH = 118;
export const PERSISTENT_NAVIGATION_DESKTOP_CONTROLS_WIDTH = (
    PERSISTENT_NAVIGATION_SIDEBAR_CONTROL_WIDTH
    + PERSISTENT_NAVIGATION_ZEN_CONTROL_WIDTH
    + 2 * PERSISTENT_NAVIGATION_BUTTON_SIZE
    + 3 * PERSISTENT_NAVIGATION_BUTTON_GAP
);

export function getPersistentHeaderPointerEvents({
    isWeb,
    inTauri,
}: {
    isWeb: boolean;
    inTauri: boolean;
}): 'none' | 'box-none' {
    return isWeb && !inTauri ? 'none' : 'box-none';
}

export function getDesktopSidebarWidth(windowWidth: number): number {
    if (windowWidth < WEB_TABLET_MIN_WIDTH) return 0;
    return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
}

export function getDesktopRightPanelWidth(windowWidth: number): number {
    if (windowWidth < DESKTOP_RIGHT_PANEL_MIN_WINDOW_WIDTH) return 0;
    return Math.min(Math.max(Math.floor(windowWidth * 0.24), 280), 360);
}

export type DesktopPanelSide = 'left' | 'right';

function getDesktopPanelBounds(side: DesktopPanelSide): { min: number; max: number } {
    return side === 'left'
        ? { min: DESKTOP_LEFT_PANEL_MIN_WIDTH, max: DESKTOP_LEFT_PANEL_MAX_WIDTH }
        : { min: DESKTOP_RIGHT_PANEL_MIN_WIDTH, max: DESKTOP_RIGHT_PANEL_MAX_WIDTH };
}

export function clampDesktopPanelWidth(side: DesktopPanelSide, width: number): number {
    const { min, max } = getDesktopPanelBounds(side);
    return Math.round(Math.min(Math.max(width, min), max));
}

export function getDesktopWorkspacePanelWidths({
    leftVisible,
    requestedLeftWidth,
    requestedRightWidth,
    rightVisible,
    windowWidth,
}: {
    leftVisible: boolean;
    requestedLeftWidth: number;
    requestedRightWidth: number;
    rightVisible: boolean;
    windowWidth: number;
}): { left: number; main: number; right: number } {
    const availableForPanels = Math.max(0, windowWidth - DESKTOP_MAIN_MIN_WIDTH);
    let left = leftVisible ? clampDesktopPanelWidth('left', requestedLeftWidth) : 0;
    let right = rightVisible ? clampDesktopPanelWidth('right', requestedRightWidth) : 0;

    if (left + right > availableForPanels) {
        if (leftVisible && rightVisible) {
            const minimumTotal = DESKTOP_LEFT_PANEL_MIN_WIDTH + DESKTOP_RIGHT_PANEL_MIN_WIDTH;
            if (availableForPanels >= minimumTotal) {
                const leftExtra = Math.max(0, left - DESKTOP_LEFT_PANEL_MIN_WIDTH);
                const rightExtra = Math.max(0, right - DESKTOP_RIGHT_PANEL_MIN_WIDTH);
                const desiredExtra = leftExtra + rightExtra;
                const availableExtra = availableForPanels - minimumTotal;
                const leftShare = desiredExtra > 0 ? leftExtra / desiredExtra : 0.5;
                left = DESKTOP_LEFT_PANEL_MIN_WIDTH + Math.floor(availableExtra * leftShare);
                right = availableForPanels - left;
            } else {
                const leftShare = DESKTOP_LEFT_PANEL_MIN_WIDTH / minimumTotal;
                left = Math.floor(availableForPanels * leftShare);
                right = availableForPanels - left;
            }
        } else if (leftVisible) {
            left = Math.min(left, availableForPanels);
        } else if (rightVisible) {
            right = Math.min(right, availableForPanels);
        }
    }

    return {
        left,
        main: Math.max(DESKTOP_MAIN_MIN_WIDTH, windowWidth - left - right),
        right,
    };
}

export function getDesktopPanelResizeWidth({
    desiredWidth,
    oppositePanelVisible,
    oppositePanelWidth,
    side,
    windowWidth,
}: {
    desiredWidth: number;
    oppositePanelVisible: boolean;
    oppositePanelWidth: number;
    side: DesktopPanelSide;
    windowWidth: number;
}): number {
    const { min, max } = getDesktopPanelBounds(side);
    const availableWidth = Math.max(
        0,
        windowWidth - DESKTOP_MAIN_MIN_WIDTH - (oppositePanelVisible ? oppositePanelWidth : 0),
    );
    const constrainedMaximum = Math.min(max, availableWidth);
    if (constrainedMaximum < min) return Math.round(constrainedMaximum);
    return Math.round(Math.min(Math.max(desiredWidth, min), constrainedMaximum));
}

export function isDesktopRightPanelRoute(pathname: string): boolean {
    return pathname === '/'
        || pathname === '/new'
        || (
            /^\/session\/[^/]+\/?$/.test(pathname)
            && !/^\/session\/search\/?$/.test(pathname)
        );
}

export function isDesktopRightPanelAvailable({
    isTablet,
    supportsPersistentPanel,
    windowWidth,
}: {
    isTablet: boolean;
    supportsPersistentPanel: boolean;
    windowWidth: number;
}): boolean {
    return isTablet
        && supportsPersistentPanel
        && windowWidth >= DESKTOP_RIGHT_PANEL_MIN_WINDOW_WIDTH;
}

export function shouldUseCompactSessionHeader({
    isTablet,
    windowWidth,
}: {
    isTablet: boolean;
    windowWidth: number;
}): boolean {
    return isTablet && windowWidth < DESKTOP_SESSION_HEADER_COMPACT_WINDOW_WIDTH;
}

export type DesktopRightPanelPresentation = 'unavailable' | 'zen' | 'collapsed' | 'expanded';

export function getDesktopRightPanelPresentation({
    available,
    collapsed,
    zenMode,
}: {
    available: boolean;
    collapsed: boolean;
    zenMode: boolean;
}): DesktopRightPanelPresentation {
    if (!available) return 'unavailable';
    if (zenMode) return 'zen';
    return collapsed ? 'collapsed' : 'expanded';
}

export function getPersistentNavigationControlsWidth(buttonCount: number): number {
    if (buttonCount <= 0) return 0;
    return (
        buttonCount * PERSISTENT_NAVIGATION_BUTTON_SIZE
        + (buttonCount - 1) * PERSISTENT_NAVIGATION_BUTTON_GAP
    );
}

export function getPersistentHeaderContentInset({
    windowWidth,
    headerMaxWidth,
    headerHorizontalPadding,
    sidebarWidth,
    sidebarVisible = true,
    rightPanelWidth = 0,
    controlStartPadding = 0,
    buttonCount,
    controlsWidth,
    targetHitSlop = 0,
}: {
    windowWidth: number;
    headerMaxWidth: number;
    headerHorizontalPadding: number;
    sidebarWidth?: number;
    sidebarVisible?: boolean;
    /** 主内容右侧被占用的宽度，例如桌面端文件面板。 */
    rightPanelWidth?: number;
    controlStartPadding?: number;
    buttonCount: number;
    /** Exact rendered width when controls are not all square icon buttons. */
    controlsWidth?: number;
    targetHitSlop?: number;
}): number {
    const renderedSidebarWidth = sidebarVisible
        ? sidebarWidth ?? getDesktopSidebarWidth(windowWidth)
        : 0;
    const mainWidth = Math.max(0, windowWidth - renderedSidebarWidth - Math.max(0, rightPanelWidth));
    const renderedHeaderWidth = Math.min(mainWidth, headerMaxWidth);
    const centeredHeaderInset = Math.max(0, (mainWidth - renderedHeaderWidth) / 2);
    const headerTargetHitLeft = centeredHeaderInset + headerHorizontalPadding - targetHitSlop;
    const controlsHitRight = (
        PERSISTENT_NAVIGATION_HORIZONTAL_PADDING
        + controlStartPadding
        + (controlsWidth ?? getPersistentNavigationControlsWidth(buttonCount))
        + PERSISTENT_NAVIGATION_HIT_SLOP
    );

    return Math.max(
        0,
        Math.ceil(controlsHitRight + PERSISTENT_NAVIGATION_TARGET_GAP - headerTargetHitLeft),
    );
}

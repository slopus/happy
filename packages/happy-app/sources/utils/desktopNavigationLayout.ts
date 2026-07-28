export const WEB_TABLET_MIN_WIDTH = 800;
export const PERSISTENT_NAVIGATION_HORIZONTAL_PADDING = 16;
export const PERSISTENT_NAVIGATION_BUTTON_SIZE = 28;
export const PERSISTENT_NAVIGATION_BUTTON_GAP = 4;
export const PERSISTENT_NAVIGATION_HIT_SLOP = 10;
export const PERSISTENT_NAVIGATION_TARGET_GAP = 4;
export const TAURI_HEADER_CONTROL_LEFT = 92;

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
    sidebarVisible = true,
    rightPanelWidth = 0,
    controlStartPadding = 0,
    buttonCount,
    targetHitSlop = 0,
}: {
    windowWidth: number;
    headerMaxWidth: number;
    headerHorizontalPadding: number;
    sidebarVisible?: boolean;
    /** 主内容右侧被占用的宽度，例如桌面端文件面板。 */
    rightPanelWidth?: number;
    controlStartPadding?: number;
    buttonCount: number;
    targetHitSlop?: number;
}): number {
    const sidebarWidth = sidebarVisible ? getDesktopSidebarWidth(windowWidth) : 0;
    const mainWidth = Math.max(0, windowWidth - sidebarWidth - Math.max(0, rightPanelWidth));
    const renderedHeaderWidth = Math.min(mainWidth, headerMaxWidth);
    const centeredHeaderInset = Math.max(0, (mainWidth - renderedHeaderWidth) / 2);
    const headerTargetHitLeft = centeredHeaderInset + headerHorizontalPadding - targetHitSlop;
    const controlsHitRight = (
        PERSISTENT_NAVIGATION_HORIZONTAL_PADDING
        + controlStartPadding
        + getPersistentNavigationControlsWidth(buttonCount)
        + PERSISTENT_NAVIGATION_HIT_SLOP
    );

    return Math.max(
        0,
        Math.ceil(controlsHitRight + PERSISTENT_NAVIGATION_TARGET_GAP - headerTargetHitLeft),
    );
}

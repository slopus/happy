const COPY_MENU_VIEWPORT_MARGIN = 12;
const COPY_MENU_TRIGGER_GAP = 12;
const COPY_MENU_ARROW_SIZE = 8;
const COPY_MENU_ARROW_EDGE_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function resolveCopyMenuPosition({
    triggerX,
    triggerY,
    menuWidth,
    menuHeight,
    viewportWidth,
    viewportHeight,
}: {
    triggerX: number;
    triggerY: number;
    menuWidth: number;
    menuHeight: number;
    viewportWidth: number;
    viewportHeight: number;
}): {
    left: number;
    top: number;
    arrowLeft: number;
} {
    const minLeft = COPY_MENU_VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, viewportWidth - COPY_MENU_VIEWPORT_MARGIN - menuWidth);
    const minTop = COPY_MENU_VIEWPORT_MARGIN;
    const maxTop = Math.max(minTop, viewportHeight - COPY_MENU_VIEWPORT_MARGIN - menuHeight);
    const left = clamp(triggerX - menuWidth / 2, minLeft, maxLeft);
    const minArrowLeft = COPY_MENU_ARROW_EDGE_MARGIN;
    const maxArrowLeft = Math.max(minArrowLeft, menuWidth - COPY_MENU_ARROW_EDGE_MARGIN - COPY_MENU_ARROW_SIZE);

    return {
        left,
        top: clamp(triggerY - menuHeight - COPY_MENU_TRIGGER_GAP, minTop, maxTop),
        arrowLeft: clamp(triggerX - left - COPY_MENU_ARROW_SIZE / 2, minArrowLeft, maxArrowLeft),
    };
}

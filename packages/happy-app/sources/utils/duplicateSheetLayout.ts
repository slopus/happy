const HORIZONTAL_MARGIN = 16;
const MAX_WIDTH = 560;
const MAX_HEIGHT_RATIO = 0.85;

export function getDuplicateSheetFrame(window: { width: number; height: number }): { width: number; maxHeight: number } {
    const availableWidth = Math.max(0, Math.floor(window.width) - HORIZONTAL_MARGIN * 2);
    return {
        width: Math.min(MAX_WIDTH, availableWidth),
        maxHeight: Math.round(Math.floor(window.height) * MAX_HEIGHT_RATIO),
    };
}

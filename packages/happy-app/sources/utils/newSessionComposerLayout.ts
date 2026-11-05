/** Keep room for navigation, composer controls and padding on short Web viewports. */
export function getNewSessionInputMaxHeight(viewportHeight: number, compact: boolean): number {
    const cap = compact ? 120 : 480;
    return Math.max(44, Math.min(cap, Math.floor(viewportHeight - 220)));
}

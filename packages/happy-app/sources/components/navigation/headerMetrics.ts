export const MOBILE_GLASS_HEADER_HEIGHT = 52;
export const MOBILE_GLASS_CONTROL_SIZE = 44;
export const MOBILE_GLASS_CONTROL_RADIUS = MOBILE_GLASS_CONTROL_SIZE / 2;

/** Clear air between the title pill and the control on either side of it. */
export const MOBILE_TITLE_PILL_GAP = 14;

/**
 * How far in from both edges the title pill is allowed to reach.
 *
 * The same inset on both sides, so the pill stays centred on the header rather
 * than on whatever space the controls happen to leave. It clears the wider of
 * the two controls, which is the only one that can be run into: the right one
 * carries a variable payload and is measured, the left is a fixed-size button.
 */
export function resolveTitlePillInset({
    leftControlWidth,
    rightControlWidth,
    gap = MOBILE_TITLE_PILL_GAP,
}: {
    leftControlWidth: number;
    rightControlWidth: number;
    gap?: number;
}): number {
    return Math.max(leftControlWidth, rightControlWidth) + gap;
}

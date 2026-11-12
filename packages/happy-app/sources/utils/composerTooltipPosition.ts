type Anchor = { left: number; top: number; width: number; height: number };

/** Position the existing above-anchor tooltip in a viewport-level host. */
export function composerTooltipPosition(anchor: Anchor, hint: { width: number; height: number }, viewport: { width: number; height: number }) {
    const center = Math.max(8 + hint.width / 2, Math.min(anchor.left + anchor.width / 2, viewport.width - 8 - hint.width / 2));
    const above = anchor.top - 8 - hint.height;
    const desiredTop = above >= 8 ? above : anchor.top + anchor.height + 8;
    const hintTop = Math.max(8, Math.min(desiredTop, viewport.height - hint.height - 8));
    return { left: center - anchor.width / 2, top: hintTop + hint.height + 8, width: anchor.width, height: anchor.height };
}

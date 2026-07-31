export interface MultiTextInputLayout {
    height: number;
    containerHeight: number;
    scrollEnabled: boolean;
}

export interface MultiTextInputLayoutOptions {
    contentHeight: number;
    hasText?: boolean;
    maxHeight: number;
    lineHeight: number;
    paddingTop?: number;
    paddingBottom?: number;
    minimumHeight?: number;
    containerChromeHeight?: number;
}

export function resolveMultiTextInputLayout({
    contentHeight,
    hasText = true,
    maxHeight,
    lineHeight,
    paddingTop = 0,
    paddingBottom = 0,
    minimumHeight: explicitMinimumHeight,
    containerChromeHeight = 0,
}: MultiTextInputLayoutOptions): MultiTextInputLayout {
    // Native contentSize can be smaller than a line for an empty input. Keep
    // the configured line plus vertical padding as the minimum visible size.
    const minimumHeight = Math.max(
        lineHeight + paddingTop + paddingBottom,
        explicitMinimumHeight ?? 0,
    );
    const cap = Math.max(0, maxHeight);
    const minimum = Math.min(minimumHeight, cap);
    const measuredHeight = hasText && Number.isFinite(contentHeight) ? contentHeight : minimum;
    const height = Math.min(cap, Math.max(minimum, measuredHeight));

    return {
        height,
        containerHeight: height + Math.max(0, containerChromeHeight),
        scrollEnabled: measuredHeight >= cap && cap > 0,
    };
}

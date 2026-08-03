export interface AgentInputLayoutGeometry {
    shellInset: number;
    actionSize: number;
    addIconSize: number;
}

export interface AgentInputLayout {
    shellInset: number;
    addGlyphOffset: number;
    textInset: number;
    inputContainerPaddingLeft: number;
    inputContainerPaddingRight: number;
}

/**
 * Canonical visual metrics for the compact mobile composer. Home and Chat
 * intentionally render different controls, but their shell, input, and action
 * geometry must stay identical.
 */
export const MOBILE_COMPOSER_METRICS = {
    shellRadius: 30,
    shellInset: 10,
    shellPaddingTop: 8,
    shellPaddingBottom: 8,
    inputMinHeight: 44,
    inputMaxHeight: 120,
    inputFontSize: 16,
    inputLineHeight: 22,
    inputPaddingTop: 4,
    inputPaddingBottom: 4,
    actionRowHeight: 42,
    actionSize: 42,
    addIconSize: 26,
    secondaryActionHeight: 40,
    effortWidth: 64,
    primaryActionSize: 42,
    primaryActionMarginLeft: 8,
    attachmentExtraHeight: 72,
} as const;

export const MOBILE_COMPOSER_BASE_HEIGHT = MOBILE_COMPOSER_METRICS.shellPaddingTop
    + MOBILE_COMPOSER_METRICS.inputMinHeight
    + MOBILE_COMPOSER_METRICS.actionRowHeight
    + MOBILE_COMPOSER_METRICS.shellPaddingBottom;

export const MOBILE_COMPOSER_CHROME_HEIGHT = MOBILE_COMPOSER_BASE_HEIGHT
    - MOBILE_COMPOSER_METRICS.inputMinHeight;

/** Mirrors the compact Chat structure: padded input container + action row. */
export function resolveMobileComposerHeight(inputHeight: number, hasAttachments = false): number {
    const inputContainerHeight = Math.max(
        MOBILE_COMPOSER_METRICS.inputMinHeight,
        inputHeight
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    );
    return MOBILE_COMPOSER_CHROME_HEIGHT
        + inputContainerHeight
        + (hasAttachments ? MOBILE_COMPOSER_METRICS.attachmentExtraHeight : 0);
}

export type MobileComposerMenuVariant = 'icon' | 'model' | 'effort';

export interface MobileComposerGeometryStyle {
    width?: number | '100%';
    height?: number | '100%';
    minWidth?: number;
    flex?: number;
    flexShrink?: number;
    flexDirection?: 'row';
    alignItems?: 'center';
    justifyContent?: 'center' | 'flex-start' | 'flex-end';
    borderRadius?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingHorizontal?: number;
    gap?: number;
    marginLeft?: number;
}

export interface MobileComposerMenuGeometry {
    frame: MobileComposerGeometryStyle;
    content: MobileComposerGeometryStyle;
}

/**
 * Keeps the Expo native-menu host frame free of visual padding. Padding and
 * alignment belong exclusively to the visible React Native label inside it.
 */
export function resolveMobileComposerMenuGeometry(
    variant: MobileComposerMenuVariant,
): MobileComposerMenuGeometry {
    if (variant === 'icon') {
        return {
            frame: {
                width: MOBILE_COMPOSER_METRICS.actionSize,
                height: MOBILE_COMPOSER_METRICS.actionSize,
                flexShrink: 0,
            },
            content: {
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
            },
        };
    }

    // The pair is right-aligned against the send button, so each chip keeps its
    // slack on the outside of the separator: the model's padding sits to its
    // left, the effort's to its right. Only the model shrinks, and the effort
    // reserves the widest label's width so switching levels never reflows the
    // row or clips the text.
    if (variant === 'model') {
        return {
            frame: {
                flexShrink: 1,
                minWidth: 0,
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
            },
            content: {
                minWidth: 0,
                height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
                borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-end',
                paddingLeft: 12,
                paddingRight: 4,
                gap: 7,
            },
        };
    }

    return {
        frame: {
            flexShrink: 0,
            minWidth: MOBILE_COMPOSER_METRICS.effortWidth,
            height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
        },
        content: {
            minWidth: 0,
            height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
            borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            paddingLeft: 4,
            paddingRight: 12,
            gap: 4,
        },
    };
}

export function resolveMobileComposerActionRowGeometry(): MobileComposerGeometryStyle {
    return {
        height: MOBILE_COMPOSER_METRICS.actionRowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 2,
        paddingHorizontal: 0,
    };
}

export function resolveMobileComposerActionGeometry(
    variant: 'icon' | 'primary',
): MobileComposerGeometryStyle {
    return {
        width: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize
            : MOBILE_COMPOSER_METRICS.actionSize,
        height: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize
            : MOBILE_COMPOSER_METRICS.actionSize,
        borderRadius: variant === 'primary'
            ? MOBILE_COMPOSER_METRICS.primaryActionSize / 2
            : MOBILE_COMPOSER_METRICS.actionSize / 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...(variant === 'primary'
            ? { marginLeft: MOBILE_COMPOSER_METRICS.primaryActionMarginLeft }
            : {}),
    };
}

/** Resolves compact mobile composer geometry from the leading add glyph. */
export function resolveAgentInputLayout({
    shellInset,
    actionSize,
    addIconSize,
}: AgentInputLayoutGeometry): AgentInputLayout {
    const addGlyphOffset = (actionSize - addIconSize) / 2;
    return {
        shellInset,
        addGlyphOffset,
        textInset: shellInset + addGlyphOffset,
        inputContainerPaddingLeft: addGlyphOffset,
        inputContainerPaddingRight: addGlyphOffset,
    };
}

export const MOBILE_COMPOSER_LAYOUT = resolveAgentInputLayout({
    shellInset: MOBILE_COMPOSER_METRICS.shellInset,
    actionSize: MOBILE_COMPOSER_METRICS.actionSize,
    addIconSize: MOBILE_COMPOSER_METRICS.addIconSize,
});

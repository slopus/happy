export const CONVERSATION_FONT_SIZES = ['small', 'default', 'large'] as const;

export type ConversationFontSize = typeof CONVERSATION_FONT_SIZES[number];

const CONVERSATION_FONT_SCALE: Record<ConversationFontSize, number> = {
    small: 0.875,
    default: 1,
    large: 1.125,
};

function scaleTextMetrics(fontSize: number, lineHeight: number, scale: number) {
    return {
        fontSize: Math.round(fontSize * scale),
        lineHeight: Math.round(lineHeight * scale),
    };
}

export function getConversationTypography(size: ConversationFontSize) {
    const scale = CONVERSATION_FONT_SCALE[size];
    return {
        scale,
        body: scaleTextMetrics(16, 25, scale),
        header1: scaleTextMetrics(16, 24, scale),
        header2: scaleTextMetrics(20, 24, scale),
        header3: scaleTextMetrics(16, 28, scale),
        header4: scaleTextMetrics(16, 24, scale),
        header5: scaleTextMetrics(16, 24, scale),
        header6: scaleTextMetrics(16, 24, scale),
        inlineCode: scaleTextMetrics(16, 24, scale),
        codeBlock: scaleTextMetrics(14, 20, scale),
        secondary: scaleTextMetrics(14, 20, scale),
        option: scaleTextMetrics(16, 24, scale),
        table: scaleTextMetrics(16, 24, scale),
    };
}

export type ConversationTypography = ReturnType<typeof getConversationTypography>;

export function getNextConversationFontSize(size: ConversationFontSize): ConversationFontSize {
    const currentIndex = CONVERSATION_FONT_SIZES.indexOf(size);
    return CONVERSATION_FONT_SIZES[(currentIndex + 1) % CONVERSATION_FONT_SIZES.length];
}

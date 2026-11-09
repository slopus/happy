import type { TextStyle } from 'react-native';
import { Typography } from '@/constants/Typography';

export type MarkdownTypographyMode = 'default' | 'chatMono' | 'document';

type MarkdownTypographyStyles = {
    body?: TextStyle;
    inlineCode?: TextStyle;
    italic?: TextStyle;
    strong?: TextStyle;
    headings?: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, TextStyle>>;
};

/**
 * One type family for every textual surface rendered inside a chat message.
 * Visual hierarchy is expressed through the bundled faces, size, color, and
 * surrounding chrome instead of switching between sans-serif and monospace.
 */
const CHAT_MONO_TYPOGRAPHY = {
    body: Typography.mono(),
    inlineCode: Typography.mono(),
    italic: {
        ...Typography.mono('italic'),
        // The italic asset is registered under its own family name.
        fontStyle: 'normal' as const,
    },
    strong: {
        ...Typography.mono('semiBold'),
        // The face already carries the weight. Reset inherited 600/700/900
        // values so native and web do not synthesize a second bold weight.
        fontWeight: 'normal' as const,
    },
} as const;

const DOCUMENT_TYPOGRAPHY: MarkdownTypographyStyles = {
    body: { fontSize: 16, lineHeight: 28 },
    inlineCode: { fontSize: 14, lineHeight: 24 },
    headings: {
        1: { fontSize: 28, lineHeight: 38, fontWeight: '600', marginTop: 0, marginBottom: 22 },
        2: { fontSize: 21, lineHeight: 31, fontWeight: '600', marginTop: 28, marginBottom: 12 },
        3: { fontSize: 18, lineHeight: 28, fontWeight: '600', marginTop: 24, marginBottom: 10 },
        4: { fontSize: 16, lineHeight: 26, fontWeight: '600', marginTop: 20, marginBottom: 8 },
        5: { fontSize: 15, lineHeight: 25, fontWeight: '600', marginTop: 18, marginBottom: 8 },
        6: { fontSize: 14, lineHeight: 24, fontWeight: '600', marginTop: 16, marginBottom: 8 },
    },
};

const DEFAULT_TYPOGRAPHY: MarkdownTypographyStyles = {};

/**
 * Returns late style overrides for an explicitly selected Markdown surface.
 * The default mode intentionally returns no overrides. Document mode is
 * explicitly selected by the workspace and its immutable history previews.
 */
export function getMarkdownTypography(mode: MarkdownTypographyMode): MarkdownTypographyStyles {
    return mode === 'document' ? DOCUMENT_TYPOGRAPHY : mode === 'chatMono' ? CHAT_MONO_TYPOGRAPHY : DEFAULT_TYPOGRAPHY;
}

import type { AgentUiConfig } from '@/agents/registryUi';

export const CLAUDE_UI: AgentUiConfig = {
    id: 'claude',
    icon: require('@/assets/images/icon-claude.png'),
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.28),
    },
    // iOS can render dingbat glyphs as emoji; force text presentation (U+FE0E).
    cliGlyph: '\u2733\uFE0E',
};


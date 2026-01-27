import type { AgentUiConfig } from '@/agents/registryUi';

export const GEMINI_UI: AgentUiConfig = {
    id: 'gemini',
    icon: require('@/assets/images/icon-gemini.png'),
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.35),
    },
    cliGlyph: '\u2726\uFE0E',
};


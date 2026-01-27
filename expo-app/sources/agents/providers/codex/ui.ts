import type { UnistylesThemes } from 'react-native-unistyles';

import type { AgentUiConfig } from '@/agents/registryUi';

export const CODEX_UI: AgentUiConfig = {
    id: 'codex',
    icon: require('@/assets/images/icon-gpt.png'),
    tintColor: (theme: UnistylesThemes[keyof UnistylesThemes]) => theme.colors.text,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
    },
    cliGlyph: '꩜',
};


import type { UnistylesThemes } from 'react-native-unistyles';

import type { AgentUiConfig } from '@/agents/registryUi';

export const AUGGIE_UI: AgentUiConfig = {
    id: 'auggie',
    icon: require('@/assets/images/icon-monochrome.png'),
    tintColor: (theme: UnistylesThemes[keyof UnistylesThemes]) => theme.colors.text,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
    },
    cliGlyph: 'A',
};


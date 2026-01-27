import type { ImageSourcePropType } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import type { AgentId } from './registryCore';

export type AgentUiConfig = Readonly<{
    id: AgentId;
    icon: ImageSourcePropType;
    /**
     * Optional tint for the icon (Codex icon is monochrome and should match text color).
     */
    tintColor: ((theme: UnistylesThemes[keyof UnistylesThemes]) => string) | null;
    /**
     * Avatar overlay sizing tweaks.
     */
    avatarOverlay: Readonly<{
        circleScale: number; // relative to avatar size
        iconScale: (params: { size: number }) => number; // absolute px derived from avatar size
    }>;
    /**
     * Text glyph used in compact CLI/profile compatibility indicators.
     */
    cliGlyph: string;
}>;

export const AGENTS_UI: Readonly<Record<AgentId, AgentUiConfig>> = Object.freeze({
    claude: {
        id: 'claude',
        icon: require('@/assets/images/icon-claude.png'),
        tintColor: null,
        avatarOverlay: {
            circleScale: 0.35,
            iconScale: ({ size }: { size: number }) => Math.round(size * 0.28),
        },
        // iOS can render dingbat glyphs as emoji; force text presentation (U+FE0E).
        cliGlyph: '\u2733\uFE0E',
    },
    codex: {
        id: 'codex',
        icon: require('@/assets/images/icon-gpt.png'),
        tintColor: (theme: UnistylesThemes[keyof UnistylesThemes]) => theme.colors.text,
        avatarOverlay: {
            circleScale: 0.35,
            iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
        },
        cliGlyph: '꩜',
    },
    opencode: {
        id: 'opencode',
        icon: require('@/assets/images/icon-monochrome.png'),
        tintColor: (theme: UnistylesThemes[keyof UnistylesThemes]) => theme.colors.text,
        avatarOverlay: {
            circleScale: 0.35,
            iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
        },
        cliGlyph: '</>',
    },
    gemini: {
        id: 'gemini',
        icon: require('@/assets/images/icon-gemini.png'),
        tintColor: null,
        avatarOverlay: {
            circleScale: 0.35,
            iconScale: ({ size }: { size: number }) => Math.round(size * 0.35),
        },
        cliGlyph: '\u2726\uFE0E',
    },
    auggie: {
        id: 'auggie',
        icon: require('@/assets/images/icon-monochrome.png'),
        tintColor: (theme: UnistylesThemes[keyof UnistylesThemes]) => theme.colors.text,
        avatarOverlay: {
            circleScale: 0.35,
            iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
        },
        cliGlyph: 'A',
    },
});

export function getAgentIconSource(agentId: AgentId): ImageSourcePropType {
    return AGENTS_UI[agentId].icon;
}

export function getAgentIconTintColor(agentId: AgentId, theme: UnistylesThemes[keyof UnistylesThemes]): string | undefined {
    const tint = AGENTS_UI[agentId].tintColor;
    if (!tint) return undefined;
    return tint(theme);
}

export function getAgentAvatarOverlaySizes(agentId: AgentId, size: number): { circleSize: number; iconSize: number } {
    const cfg = AGENTS_UI[agentId];
    const circleSize = Math.round(size * cfg.avatarOverlay.circleScale);
    const iconSize = cfg.avatarOverlay.iconScale({ size });
    return { circleSize, iconSize };
}

export function getAgentCliGlyph(agentId: AgentId): string {
    return AGENTS_UI[agentId].cliGlyph;
}

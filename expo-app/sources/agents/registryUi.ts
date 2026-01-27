import type { ImageSourcePropType } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import type { AgentId } from './registryCore';

import { CLAUDE_UI } from './providers/claude/ui';
import { CODEX_UI } from './providers/codex/ui';
import { OPENCODE_UI } from './providers/opencode/ui';
import { GEMINI_UI } from './providers/gemini/ui';
import { AUGGIE_UI } from './providers/auggie/ui';

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
    claude: CLAUDE_UI,
    codex: CODEX_UI,
    opencode: OPENCODE_UI,
    gemini: GEMINI_UI,
    auggie: AUGGIE_UI,
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

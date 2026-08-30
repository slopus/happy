// The `avatarStyle` setting predates the current renderer set and syncs
// between app versions as a free string, so every read goes through a
// normalizer instead of trusting the stored value.

export const AVATAR_STYLES = ['brutalist', 'pixelated', 'gradient'] as const;
export type AvatarStyle = typeof AVATAR_STYLES[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'brutalist';

export function normalizeAvatarStyle(value: string | null | undefined): AvatarStyle {
    return (AVATAR_STYLES as readonly string[]).includes(value ?? '')
        ? value as AvatarStyle
        : DEFAULT_AVATAR_STYLE;
}

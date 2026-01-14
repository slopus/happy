import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { AIBackendProfile } from '@/sync/settings';

type Props = {
    profile: Pick<AIBackendProfile, 'compatibility'>;
    size?: number;
    style?: ViewStyle;
};

export function ProfileCompatibilityIcon({ profile, size = 32, style }: Props) {
    const { theme } = useUnistyles();

    const hasClaude = !!profile.compatibility?.claude;
    const hasCodex = !!profile.compatibility?.codex;
    const hasGemini = !!profile.compatibility?.gemini;

    const glyph =
        hasClaude && hasCodex ? '✳꩜' :
            hasClaude ? '✳' :
                hasCodex ? '꩜' :
                    hasGemini ? '✦' :
                        '•';

    // Match visual size across glyphs (codex glyph runs larger; claude glyph runs smaller).
    const glyphSize =
        glyph === '✳' ? Math.round(size * 1.08) :
            glyph === '꩜' ? Math.round(size * 0.82) :
                glyph === '✳꩜' ? Math.round(size * 0.78) :
                    Math.round(size * 0.85);

    return (
        <View
            style={[
                {
                    width: size,
                    height: size,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                style,
            ]}
        >
            <Text style={{ fontSize: glyphSize, color: theme.colors.textSecondary, ...Typography.default() }}>
                {glyph}
            </Text>
        </View>
    );
}

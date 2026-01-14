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

export function ProfileCompatibilityIcon({ profile, size = 29, style }: Props) {
    const { theme } = useUnistyles();

    const glyph =
        profile.compatibility?.claude && profile.compatibility?.codex ? '✳꩜' :
            profile.compatibility?.claude ? '✳' :
                profile.compatibility?.codex ? '꩜' :
                    '•';

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
            <Text style={{ fontSize: 18, color: theme.colors.textSecondary, ...Typography.default() }}>
                {glyph}
            </Text>
        </View>
    );
}

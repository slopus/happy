import React from 'react';
import { Text, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { AIBackendProfile } from '@/sync/settings';
import { useSetting } from '@/sync/storage';

type Props = {
    profile: Pick<AIBackendProfile, 'compatibility'>;
    size?: number;
    style?: ViewStyle;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    stack: {
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
    },
    glyph: {
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export function ProfileCompatibilityIcon({ profile, size = 32, style }: Props) {
    useUnistyles();
    const styles = stylesheet;
    const experimentsEnabled = useSetting('experiments');

    const hasClaude = !!profile.compatibility?.claude;
    const hasCodex = !!profile.compatibility?.codex;
    const hasGemini = experimentsEnabled && !!profile.compatibility?.gemini;

    const glyphs = React.useMemo(() => {
        const items: Array<{ key: string; glyph: string; factor: number }> = [];
        if (hasClaude) items.push({ key: 'claude', glyph: '✳', factor: 1.14 });
        if (hasCodex) items.push({ key: 'codex', glyph: '꩜', factor: 0.82 });
        if (hasGemini) items.push({ key: 'gemini', glyph: '✦', factor: 0.88 });
        if (items.length === 0) items.push({ key: 'none', glyph: '•', factor: 0.85 });
        return items;
    }, [hasClaude, hasCodex, hasGemini]);

    const multiScale = glyphs.length === 1 ? 1 : glyphs.length === 2 ? 0.6 : 0.5;

    return (
        <View style={[styles.container, { width: size, height: size }, style]}>
            {glyphs.length === 1 ? (
                <Text style={[styles.glyph, { fontSize: Math.round(size * glyphs[0].factor) }]}>
                    {glyphs[0].glyph}
                </Text>
            ) : (
                <View style={styles.stack}>
                    {glyphs.map((item) => {
                        const fontSize = Math.round(size * multiScale * item.factor);
                        return (
                            <Text
                                key={item.key}
                                style={[
                                    styles.glyph,
                                    {
                                        fontSize,
                                        lineHeight: Math.max(10, Math.round(fontSize * 0.92)),
                                    },
                                ]}
                            >
                                {item.glyph}
                            </Text>
                        );
                    })}
                </View>
            )}
        </View>
    );
}

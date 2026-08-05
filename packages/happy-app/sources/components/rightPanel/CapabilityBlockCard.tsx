import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Props = {
    count: number;
    disabled?: boolean;
    icon: React.ReactNode;
    preview?: string | null;
    title: string;
    onPress?: () => void;
    testID?: string;
};

export const CapabilityBlockCard = React.memo(function CapabilityBlockCard({
    count,
    disabled = false,
    icon,
    preview,
    title,
    onPress,
    testID,
}: Props) {
    const { theme } = useUnistyles();

    return (
        <Pressable
            disabled={disabled || !onPress}
            onPress={onPress}
            testID={testID}
            style={({ pressed }) => [
                styles.card,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    opacity: disabled ? 0.62 : 1,
                    transform: [{ scale: pressed ? 0.985 : 1 }],
                },
            ]}
        >
            <View style={styles.topRow}>
                <View style={[styles.iconWrap, { backgroundColor: theme.colors.surfaceHigh }]}>
                    {icon}
                </View>
                <Text style={[styles.count, { color: theme.colors.text }]}>{count}</Text>
            </View>
            <Text numberOfLines={2} style={[styles.title, { color: theme.colors.text }]}>
                {title}
            </Text>
            {preview ? (
                <Text numberOfLines={2} style={[styles.preview, { color: theme.colors.textSecondary }]}>
                    {preview}
                </Text>
            ) : (
                <View style={styles.previewSpacer} />
            )}
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    card: {
        borderRadius: 18,
        borderWidth: 1,
        minHeight: 112,
        paddingHorizontal: 12,
        paddingVertical: 12,
        width: '48.5%',
    },
    topRow: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    iconWrap: {
        alignItems: 'center',
        borderRadius: 12,
        height: 34,
        justifyContent: 'center',
        width: 34,
    },
    count: {
        fontSize: 24,
        fontWeight: '700',
        letterSpacing: -0.4,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        lineHeight: 18,
        marginBottom: 6,
        minHeight: 36,
    },
    preview: {
        fontSize: 12,
        lineHeight: 16,
        minHeight: 32,
    },
    previewSpacer: {
        minHeight: 32,
    },
}));

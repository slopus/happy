import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const DesktopShortcutTooltip = React.memo(function DesktopShortcutTooltip({
    align = 'left',
    label,
    shortcut,
    testID,
    visible,
}: {
    align?: 'left' | 'right';
    label: string;
    shortcut: string;
    testID: string;
    visible: boolean;
}) {
    if (!visible) return null;

    return (
        <View
            accessibilityRole="text"
            style={[styles.tooltip, align === 'right' ? styles.alignRight : styles.alignLeft]}
            testID={testID}
        >
            <Text numberOfLines={1} style={styles.label}>{label}</Text>
            <Text numberOfLines={1} style={styles.shortcut}>{shortcut}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    tooltip: {
        position: 'absolute',
        top: 36,
        zIndex: 1400,
        minWidth: 150,
        maxWidth: 260,
        paddingHorizontal: 10,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 9,
        backgroundColor: theme.colors.text,
        pointerEvents: 'none',
    },
    alignLeft: {
        left: 0,
    },
    alignRight: {
        right: 0,
    },
    label: {
        flex: 1,
        color: theme.colors.surface,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    shortcut: {
        color: theme.colors.surface,
        opacity: 0.72,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));

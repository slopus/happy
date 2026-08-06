import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const DesktopShortcutTooltip = React.memo(function DesktopShortcutTooltip({
    align = 'left',
    label,
    multiline = false,
    shortcut,
    testID,
    visible,
}: {
    align?: 'left' | 'right';
    label: string;
    multiline?: boolean;
    shortcut?: string;
    testID: string;
    visible: boolean;
}) {
    if (!visible) return null;

    return (
        <View
            accessibilityRole="text"
            style={[
                styles.tooltip,
                multiline && styles.tooltipMultiline,
                align === 'right' ? styles.alignRight : styles.alignLeft,
            ]}
            testID={testID}
        >
            <Text
                numberOfLines={multiline ? undefined : 1}
                style={[styles.label, multiline && styles.labelMultiline]}
            >
                {label}
            </Text>
            {shortcut ? <Text numberOfLines={1} style={styles.shortcut}>{shortcut}</Text> : null}
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
    tooltipMultiline: {
        width: 380,
        maxWidth: 380,
        flexDirection: 'column',
        alignItems: 'stretch',
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
    labelMultiline: {
        flex: 0,
        lineHeight: 17,
    },
    shortcut: {
        color: theme.colors.surface,
        opacity: 0.72,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));

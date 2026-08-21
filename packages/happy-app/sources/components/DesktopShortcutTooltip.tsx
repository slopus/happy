import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const DesktopShortcutTooltip = React.memo(function DesktopShortcutTooltip({
    align = 'left',
    compact = false,
    label,
    multiline = false,
    placement = 'below',
    shortcut,
    testID,
    visible,
}: {
    align?: 'center' | 'left' | 'right';
    compact?: boolean;
    label: string;
    multiline?: boolean;
    placement?: 'above' | 'below';
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
                placement === 'above' ? styles.placementAbove : styles.placementBelow,
                compact && styles.tooltipCompact,
                multiline && styles.tooltipMultiline,
                align === 'center'
                    ? styles.alignCenter
                    : align === 'right'
                        ? styles.alignRight
                        : styles.alignLeft,
            ]}
            testID={testID}
        >
            <Text
                numberOfLines={multiline ? undefined : 1}
                style={[styles.label, compact && styles.labelCompact, multiline && styles.labelMultiline]}
            >
                {label}
            </Text>
            {shortcut ? <Text numberOfLines={1} style={styles.shortcut}>{shortcut}</Text> : null}
            {compact ? (
                <View
                    style={[
                        styles.caret,
                        align === 'center' ? styles.caretCenter : styles.caretRight,
                        placement === 'above' ? styles.caretBelow : styles.caretAbove,
                    ]}
                />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    tooltip: {
        position: 'absolute',
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
    placementAbove: {
        bottom: 42,
    },
    placementBelow: {
        top: 36,
    },
    tooltipCompact: {
        minWidth: 0,
        paddingHorizontal: 10,
        paddingVertical: 8,
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
    alignCenter: {
        left: '50%',
        transform: [{ translateX: '-50%' }],
    },
    alignRight: {
        right: 0,
    },
    label: {
        flexGrow: 1,
        color: theme.colors.surface,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    labelCompact: {
        flexGrow: 0,
        flexShrink: 0,
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
    caret: {
        position: 'absolute',
        width: 9,
        height: 9,
        backgroundColor: theme.colors.text,
        transform: [{ rotate: '45deg' }],
    },
    caretRight: {
        right: 13,
    },
    caretCenter: {
        left: '50%',
        marginLeft: -4.5,
    },
    caretAbove: {
        top: -4,
    },
    caretBelow: {
        bottom: -4,
    },
}));

import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type DesktopRightPanelTab = {
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
};

export const DesktopRightPanel = React.memo(function DesktopRightPanel({
    activeTab,
    children,
    collapseAccessibilityLabel,
    collapseLabel,
    onCollapse,
    onTabChange,
    tabs,
}: {
    activeTab: string;
    children: React.ReactNode;
    collapseAccessibilityLabel: string;
    collapseLabel: string;
    onCollapse: () => void;
    onTabChange: (key: string) => void;
    tabs: readonly DesktopRightPanelTab[];
}) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container} testID="desktop-right-panel">
            <View style={styles.header}>
                <View style={styles.tabs}>
                    {tabs.map((tab) => {
                        const selected = tab.key === activeTab;
                        return (
                            <Pressable
                                accessibilityLabel={tab.label}
                                accessibilityRole="tab"
                                accessibilityState={{ selected }}
                                key={tab.key}
                                onPress={() => onTabChange(tab.key)}
                                style={({ pressed }) => [
                                    styles.tab,
                                    selected && styles.tabSelected,
                                    pressed && styles.pressed,
                                ]}
                                testID={`desktop-right-panel-${tab.key}-tab`}
                            >
                                <Ionicons
                                    color={selected ? theme.colors.text : theme.colors.textSecondary}
                                    name={tab.icon}
                                    size={15}
                                />
                                <Text
                                    numberOfLines={1}
                                    style={[styles.tabText, selected && styles.tabTextSelected]}
                                >
                                    {tab.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
                <Pressable
                    accessibilityLabel={collapseAccessibilityLabel}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={onCollapse}
                    style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}
                    testID="desktop-right-panel-collapse-button"
                >
                    <Text style={styles.collapseText}>{collapseLabel}</Text>
                    <Ionicons name="chevron-forward" size={19} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={styles.content}>
                {children}
            </View>
        </View>
    );
});

export const DesktopRightPanelRestoreButton = React.memo(function DesktopRightPanelRestoreButton({
    label,
    onPress,
}: {
    label: string;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();

    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onPress}
            style={({ pressed }) => [styles.restoreButton, pressed && styles.pressed]}
            testID="desktop-right-panel-restore-button"
        >
            <Ionicons name="albums-outline" size={16} color={theme.colors.header.tint} />
            <Text numberOfLines={1} style={styles.restoreText}>{label}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.groupped.background,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    header: {
        minHeight: 48,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    tabs: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    tab: {
        minWidth: 0,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 7,
        borderRadius: 9,
    },
    tabSelected: {
        backgroundColor: theme.colors.surfacePressed,
    },
    tabText: {
        minWidth: 0,
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    tabTextSelected: {
        color: theme.colors.text,
    },
    collapseButton: {
        minWidth: 52,
        height: 30,
        paddingLeft: 7,
        paddingRight: 4,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        borderRadius: 8,
    },
    collapseText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
    restoreButton: {
        maxWidth: 164,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    restoreText: {
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    pressed: {
        opacity: 0.7,
    },
}));

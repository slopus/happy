/**
 * ActionMenu Component
 *
 * A simple vertical action menu that can be shown via Modal.show()
 * Used as an alternative to ActionSheetIOS for Android and Web platforms.
 */

import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export interface ActionMenuItem {
    label: string;
    onPress: () => void;
    destructive?: boolean;
    /** Display label in secondary/muted color */
    secondary?: boolean;
}

interface ActionMenuProps {
    items: ActionMenuItem[];
    onClose: () => void;
    title?: string;
}

const styles = StyleSheet.create((theme) => ({
    wrapper: {
        width: '100%',
        maxWidth: 400,
        paddingHorizontal: 8,
    },
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
    },
    item: {
        paddingVertical: 16,
        paddingHorizontal: 20,
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    itemLast: {
        borderBottomWidth: 0,
    },
    itemText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default(),
    },
    itemTextDestructive: {
        color: theme.colors.textDestructive,
    },
    itemTextSecondary: {
        color: theme.colors.textSecondary,
    },
    titleContainer: {
        paddingVertical: 12,
        paddingHorizontal: 20,
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    titleText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    cancelContainer: {
        marginTop: 8,
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
    },
    cancelItem: {
        paddingVertical: 16,
        paddingHorizontal: 20,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 17,
        color: theme.colors.textLink,
        ...Typography.default('semiBold'),
    },
}));

export function ActionMenu({ items, onClose, title }: ActionMenuProps) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    const handleItemPress = (item: ActionMenuItem) => {
        // Call item.onPress first (may be wrapped to defer execution)
        item.onPress();
        // Then close the menu
        onClose();
    };

    return (
        <View style={[styles.wrapper, { paddingBottom: safeArea.bottom + 8 }]}>
            <View style={[styles.container, { maxHeight: 400 }]}>
                {title ? (
                    <View style={styles.titleContainer}>
                        <Text style={styles.titleText}>{title}</Text>
                    </View>
                ) : null}
                <ScrollView bounces={false}>
                    {items.map((item, index) => (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                styles.item,
                                index === items.length - 1 && styles.itemLast,
                                pressed && { backgroundColor: theme.colors.surfacePressed },
                            ]}
                            onPress={() => handleItemPress(item)}
                        >
                            <Text
                                style={[
                                    styles.itemText,
                                    item.destructive && styles.itemTextDestructive,
                                    item.secondary && styles.itemTextSecondary,
                                ]}
                            >
                                {item.label}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>
            </View>
            <View style={styles.cancelContainer}>
                <Pressable
                    style={({ pressed }) => [
                        styles.cancelItem,
                        pressed && { backgroundColor: theme.colors.surfacePressed },
                    ]}
                    onPress={onClose}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
